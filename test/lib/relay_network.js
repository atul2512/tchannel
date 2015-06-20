// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var tape = require('tape');
var parallel = require('run-parallel');
var NullStatsd = require('uber-statsd-client/null');
var debugLogtron = require('debug-logtron');
var inherits = require('util').inherits;
var tapeCluster = require('tape-cluster');

var allocCluster = require('./alloc-cluster.js');
var EventEmitter = require('../../lib/event_emitter.js');
var EndpointHandler = require('../../endpoint-handler.js');
var ServiceProxy = require('../../hyperbahn/service_proxy.js');

function noop() {}

// e.g., topology = {'alice': ['127.0.0.1:4040'], 'bob': ['127.0.0.1:4041']}, '127.0.0.1:4040'
function FakeEgressNodes(topology, hostPort) {
    var self = this;
    EventEmitter.call(self);
    self.hostPort = hostPort;
    self.topology = topology;
    self.membershipChangedEvent = self.defineEvent('membershipChanged');
}

inherits(FakeEgressNodes, EventEmitter);

FakeEgressNodes.prototype.isExitFor = function isExitFor(serviceName) {
    var self = this;
    return self.topology[serviceName].indexOf(self.hostPort) >= 0;
};

FakeEgressNodes.prototype.exitsFor = function exitsFor(serviceName) {
    var self = this;
    var hostPorts = self.topology[serviceName];
    var result = Object.create(null);
    hostPorts.forEach(function (hostPort, index) {
        result[hostPort] = serviceName + "~" + index;
    });
    return result;
};

function RelayNetwork(options) {
    if (!(this instanceof RelayNetwork)) {
        return new RelayNetwork(options);
    }

    var self = this;

    self.numRelays = options.numRelays || 3;
    self.numInstancesPerService = options.numInstancesPerService || 3;
    self.serviceNames = options.serviceNames || ['alice', 'bob', 'charlie'];
    self.kValue = options.kValue || 2;
    self.createCircuits = options.createCircuits || noop;
    self.clusterOptions = options.cluster || {};

    self.numPeers = self.numRelays + self.serviceNames.length * self.numInstancesPerService;
    self.clusterOptions.numPeers = self.numPeers;
    self.cluster = null;
    self.topology = null;
    self.relayChannels = null;
    self.serviceChannels = null;
    self.serviceChannelsByName = null;

    var relayIndexes = [];
    for (var relayIndex = 0; relayIndex < self.numRelays; relayIndex++) {
        relayIndexes.push(relayIndex);
    }
    self.relayIndexes = relayIndexes;

    var instanceIndexes = [];
    for (var instanceIndex = 0; instanceIndex < self.numInstancesPerService; instanceIndex++) {
        instanceIndexes.push(instanceIndex);
    }
    self.instanceIndexes = instanceIndexes;
}

RelayNetwork.test = tapeCluster(tape, RelayNetwork);

RelayNetwork.prototype.bootstrap = function bootstrap(cb) {
    var self = this;

    allocCluster(self.clusterOptions).ready(clusterReady);

    function clusterReady(cluster) {
        self.setCluster(cluster);
        self.connect(cb);
    }
};

RelayNetwork.prototype.close = function close(cb) {
    var self = this;

    self.cluster.destroy();
    cb();
};

RelayNetwork.prototype.setCluster = function setCluster(cluster) {
    var self = this;
    self.cluster = cluster;

    // consume channels for the following services
    var nextChannelIndex = 0;

    self.relayChannels = self.relayIndexes.map(function () {
        return cluster.channels[nextChannelIndex++];
    });

    self.serviceChannels = [];
    self.serviceChannelsByName = {};
    self.serviceNames.forEach(function (serviceName) {
        var channels = self.instanceIndexes.map(function (instanceIndex) {
            return cluster.channels[nextChannelIndex++];
        });
        self.serviceChannels.push(channels);
        self.serviceChannelsByName[serviceName] = channels;
    });

    // Create a relay topology for egress nodes.
    self.topology = {};
    self.serviceChannels.forEach(function (channels, index) {
        var serviceName = self.serviceNames[index];
        var relayHostPorts = [];
        for (var kIndex = 0; kIndex < self.kValue; kIndex++) {
            var hostPort = self.relayChannels[
                (index + kIndex) %
                self.relayChannels.length
            ].hostPort;

            if (relayHostPorts.indexOf(hostPort) === -1) {
                relayHostPorts.push(hostPort);
            }
        }
        self.topology[serviceName] = relayHostPorts;
    });

    self.egressNodesForRelay = self.relayChannels.map(function eachRelay(relayChannel, index) {
        return new FakeEgressNodes(self.topology, relayChannel.hostPort);
    });

    // Set up relays
    self.relayChannels.forEach(function (relayChannel, index) {
        var egressNodes = self.egressNodesForRelay[index];
        var statsd = new NullStatsd();

        relayChannel.handler = new ServiceProxy({
            channel: relayChannel,
            logger: debugLogtron('serviceproxy' + index, {enabled: true}),
            statsd: statsd,
            egressNodes: egressNodes,
            circuits: self.createCircuits({
                timers: relayChannel.timers,
                random: null,
                period: null,
                maxErrorRate: null,
                minRequests: null,
                probation: null
            })
        });

        // In response to artificial advertisement
        self.serviceNames.forEach(function eachServiceName(serviceName, index) {
            if (egressNodes.isExitFor(serviceName)) {
                self.serviceChannels[index].forEach(function (serviceChannel) {
                    relayChannel.handler.getServicePeer(serviceName, serviceChannel.hostPort);
                });
            }
        });
    });

    // Create and connect service channels
    self.subChannels = [];
    self.subChannelsByName = {};
    self.serviceChannels.forEach(function (channels, serviceIndex) {
        var serviceName = self.serviceNames[serviceIndex];
        var subChannels = channels.map(function (channel, channelIndex) {
            var subChannel = channel.makeSubChannel({
                serviceName: serviceName,
                requestDefaults: {
                    headers: {
                        cn: serviceName
                    },
                    hasNoParent: true
                },
                peers: self.topology[serviceName] // TODO this really ought to be linked directly to the root peers
            });

            // Set up server
            var endpointHandler = new EndpointHandler(serviceName);
            subChannel.handler = endpointHandler;

            return subChannel;
        });
        self.subChannels.push(subChannels);
        self.subChannelsByName[serviceName] = subChannels;
    });

};

RelayNetwork.prototype.forEachSubChannel = function (callback) {
    var self = this;
    self.subChannels.forEach(function (subChannels, serviceIndex) {
        var serviceName = self.serviceNames[serviceIndex];
        subChannels.forEach(function (subChannel, instanceIndex) {
            callback(subChannel, serviceName, instanceIndex);
        });
    });
};

RelayNetwork.prototype.connect = function connect(callback) {
    var self = this;

    function connectRelays(callback) {
        return self.cluster.connectChannels(
            self.relayChannels,
            callback
        );
    }

    function connectServices(callback) {
        self.connectServices(callback);
    }

    return parallel([connectRelays, connectServices], callback);
};

RelayNetwork.prototype.connectServices = function connectServices(callback) {
    var self = this;

    var plans = [];

    self.relayChannels.forEach(function (relayChannel, relayIndex) {
        self.serviceNames.forEach(function (serviceName) {
            if (self.egressNodesForRelay[relayIndex].isExitFor(serviceName)) {
                plans.push(planToConnect(
                    relayChannel,
                    self.serviceChannelsByName[serviceName]
                ));
            }
        });
    });

    function planToConnect(channel, channels) {
        return function connect(callback) {
            return self.cluster.connectChannelToChannels(channel, channels, callback);
        };
    }

    return parallel(plans, callback);
};

module.exports = RelayNetwork;