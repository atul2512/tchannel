package tchannel

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

import (
	"errors"
	"io"

	"github.com/uber/tchannel/golang/typed"
)

var (
	errReqResReaderStateMismatch = errors.New("attempting read outside of expected state")
	errReqResWriterStateMismatch = errors.New("attempting write outside of expected state")
)

// reqResWriterState defines the state of a request/response writer
type reqResWriterState int

const (
	reqResWriterPreArg1 reqResWriterState = iota
	reqResWriterPreArg2
	reqResWriterPreArg3
	reqResWriterComplete
)

// messageForFragment determines which message should be used for the given
// fragment
type messageForFragment func(initial bool) message

// A reqResWriter writes out requests/responses.  Exactly which it does is
// determined by its messageForFragment function which returns the appropriate
// message to use when building an initial or follow-on fragment.
type reqResWriter struct {
	conn               *Connection
	contents           *fragmentingWriter
	mex                *messageExchange
	state              reqResWriterState
	messageForFragment messageForFragment
	err                error
}

func (w *reqResWriter) argWriter(last bool, inState reqResWriterState, outState reqResWriterState) (io.WriteCloser, error) {
	if w.err != nil {
		return nil, w.err
	}

	if w.state != inState {
		return nil, w.failed(errReqResWriterStateMismatch)
	}

	argWriter, err := w.contents.ArgWriter(last)
	if err != nil {
		return nil, err
	}

	w.state = outState
	return argWriter, nil
}

func (w *reqResWriter) arg1Writer() (io.WriteCloser, error) {
	return w.argWriter(false /* last */, reqResWriterPreArg1, reqResWriterPreArg2)
}

func (w *reqResWriter) arg2Writer() (io.WriteCloser, error) {
	return w.argWriter(false /* last */, reqResWriterPreArg2, reqResWriterPreArg3)
}

func (w *reqResWriter) arg3Writer() (io.WriteCloser, error) {
	return w.argWriter(true /* last */, reqResWriterPreArg3, reqResWriterComplete)
}

// newFragment creates a new fragment for marshaling into
func (w *reqResWriter) newFragment(initial bool, checksum Checksum) (*writableFragment, error) {
	message := w.messageForFragment(initial)

	// Create the frame
	frame := w.conn.framePool.Get()
	frame.Header.ID = w.mex.msgID
	frame.Header.messageType = message.messageType()

	// Write the message into the fragment, reserving flags and checksum bytes
	wbuf := typed.NewWriteBuffer(frame.Payload[:])
	fragment := new(writableFragment)
	fragment.frame = frame
	fragment.flagsRef = wbuf.DeferByte()
	if err := message.write(wbuf); err != nil {
		return nil, err
	}
	wbuf.WriteByte(byte(checksum.TypeCode()))
	fragment.checksumRef = wbuf.DeferBytes(checksum.Size())
	fragment.checksum = checksum
	fragment.contents = wbuf
	return fragment, wbuf.Err()
}

// flushFragment sends a fragment to the peer over the connection
func (w *reqResWriter) flushFragment(fragment *writableFragment) error {
	if w.err != nil {
		return w.err
	}

	frame := fragment.frame.(*Frame)
	frame.Header.SetPayloadSize(uint16(fragment.contents.BytesWritten()))
	select {
	case <-w.mex.ctx.Done():
		return w.failed(w.mex.ctx.Err())
	case w.conn.sendCh <- frame:
		return nil
	default:
		return w.failed(ErrSendBufferFull)
	}
}

// failed marks the writer as having failed
func (w *reqResWriter) failed(err error) error {
	if w.err != nil {
		return w.err
	}

	w.mex.shutdown()
	w.err = err
	return w.err
}

// reqResReaderState defines the state of a request/response reader
type reqResReaderState int

const (
	reqResReaderPreArg1 reqResReaderState = iota
	reqResReaderPreArg2
	reqResReaderPreArg3
	reqResReaderComplete
)

// A reqResReader is capable of reading arguments from a request or response object.
type reqResReader struct {
	contents           *fragmentingReader
	mex                *messageExchange
	state              reqResReaderState
	messageForFragment messageForFragment
	initialFragment    *readableFragment
	err                error
}

// arg1Reader returns an io.ReadCloser to read arg1.
func (r *reqResReader) arg1Reader() (io.ReadCloser, error) {
	return r.argReader(false /* last */, reqResReaderPreArg1, reqResReaderPreArg2)
}

// arg2Reader returns an io.ReadCloser to read arg2.
func (r *reqResReader) arg2Reader() (io.ReadCloser, error) {
	return r.argReader(false /* last */, reqResReaderPreArg2, reqResReaderPreArg3)
}

// arg3Reader returns an io.ReadCloser to read arg3.
func (r *reqResReader) arg3Reader() (io.ReadCloser, error) {
	return r.argReader(true /* last */, reqResReaderPreArg3, reqResReaderComplete)
}

// argReader returns an io.ReadCloser that can be used to read an argument. The ReadCloser
// must be closed once the argument has been read.
func (r *reqResReader) argReader(last bool, inState reqResReaderState, outState reqResReaderState) (io.ReadCloser, error) {
	if r.state != inState {
		return nil, r.failed(errReqResReaderStateMismatch)
	}

	argReader, err := r.contents.ArgReader(last)
	if err != nil {
		return nil, r.failed(err)
	}

	r.state = outState
	return argReader, nil
}

// recvNextFragment receives the next fragment from the underlying message exchange.
func (r *reqResReader) recvNextFragment(initial bool) (*readableFragment, error) {
	if r.initialFragment != nil {
		fragment := r.initialFragment
		r.initialFragment = nil
		return fragment, nil
	}

	// Wait for the appropriate message from the peer
	message := r.messageForFragment(initial)
	frame, err := r.mex.recvPeerFrameOfType(message.messageType())
	if err != nil {
		return nil, r.failed(err)
	}

	// Parse the message and setup the fragment
	fragment, err := parseInboundFragment(frame, message)
	if err != nil {
		return nil, r.failed(err)
	}

	return fragment, nil
}

// failed indicates the reader failed
func (r *reqResReader) failed(err error) error {
	if r.err != nil {
		return r.err
	}

	r.mex.shutdown()
	r.err = err
	return r.err
}

// parseInboundFragment parses an incoming fragment based on the given message
func parseInboundFragment(frame *Frame, message message) (*readableFragment, error) {
	rbuf := typed.NewReadBuffer(frame.SizedPayload())
	fragment := new(readableFragment)
	fragment.flags = rbuf.ReadByte()
	if err := message.read(rbuf); err != nil {
		return nil, err
	}

	fragment.checksumType = ChecksumType(rbuf.ReadByte())
	fragment.checksum = rbuf.ReadBytes(fragment.checksumType.ChecksumSize())
	fragment.contents = rbuf
	return fragment, rbuf.Err()
}
