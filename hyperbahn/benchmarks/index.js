// Copyright (c) 2015 Uber Technologies, Inc.

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

/*eslint no-console: 0*/
var parseArgs = require('minimist');
var process = require('process');
var util = require('util');
var path = require('path');
var FakeKafkaServer = require('kafka-logger/test/lib/kafka-server');
var FakeSentryServer = require('sentry-logger/test/lib/sentry-server');

var BenchmarkRunner = require('tchannel/benchmarks/');

var bahn = path.join(__dirname, 'hyperbahn-worker.js');

function HyperbahnBenchmarkRunner(opts) {
    if (!(this instanceof HyperbahnBenchmarkRunner)) {
        return new HyperbahnBenchmarkRunner(opts);
    }

    var self = this;
    BenchmarkRunner.call(self, opts);
}
util.inherits(HyperbahnBenchmarkRunner, BenchmarkRunner);

HyperbahnBenchmarkRunner.prototype.startFakeSentry =
function startFakeSentry() {
    var self = this;
    self.sentry = FakeSentryServer(onSentry);

    function onSentry(msg) {
    }
};

HyperbahnBenchmarkRunner.prototype.startFakeKafka =
function startFakeKafka() {
    var self = this;
    self.kafka = FakeKafkaServer(onKafkaMessage);

    function onKafkaMessage(msg) {
    }
};

HyperbahnBenchmarkRunner.prototype.spawnRelayServer =
function spawnRelayServer() {
    var self = this;

    self.startFakeKafka();
    self.startFakeSentry();

    var hyperbahnProc = self.run(bahn, [
        '--serverPort', String(self.ports.serverPort),
        '--serverServiceName', String(self.serviceName),
        '--instances', String(self.instanceCount),
        '--workerPort', String(self.ports.relayServerPort),
        '--statsdPort', String(self.ports.statsdPort),
        '--kafkaPort', String(self.kafka.port),
        '--sentryPort', String(self.sentry.address().port)
    ]);
    self.relayProcs.push(hyperbahnProc);
    hyperbahnProc.stdout.pipe(process.stderr);
    hyperbahnProc.stderr.pipe(process.stderr);
};

HyperbahnBenchmarkRunner.prototype.close = function close() {
    var self = this;

    BenchmarkRunner.prototype.close.call(self);

    self.sentry.close();
    self.kafka.close();
};

if (require.main === module) {
    var argv = parseArgs(process.argv.slice(2), {
        '--': true,
        alias: {
            o: 'output'
        },
        boolean: ['relay', 'trace', 'debug', 'noEndpointOverhead']
    });
    process.title = 'nodejs-benchmarks-top-level-runner';
    var runner = HyperbahnBenchmarkRunner(argv);
    runner.start();
}
