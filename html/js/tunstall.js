/*
Corto
Copyright (c) 2017-2020, Visual Computing Lab, ISTI - CNR
All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/

function Tunstall() {
}


Tunstall.prototype = {
	wordsize: 8,
	dictionary_size: 256,
	starts: new Uint32Array(256), //starts of each queue
	queue: new Uint32Array(512), //array of n symbols array of prob, position in buffer, length //limit to 8k*3
	index: new Uint32Array(512),
	lengths: new Uint32Array(512),
	table: new Uint8Array(8192), //worst case for 2 

	decompress: function(stream, data) {
		var nsymbols = stream.readUChar();
		this.probs = stream.readArray(nsymbols*2);
		this.createDecodingTables();
		var size = stream.readInt();
		if(size > 100000000) throw("TOO LARGE!");
		if(!data)
			data = new Uint8Array(size);
		if(data.length < size)
			throw "Array for results too small";
		data.readed = size;

		var compressed_size = stream.readInt();
		if(size > 100000000) throw("TOO LARGE!");
		var compressed_data = stream.readArray(compressed_size);
		if(size)
			this._decompress(compressed_data, compressed_size, data, size);
		return data;
	}, 


	createDecodingTables: function() {

		var t = this;
		var n_symbols = t.probs.length/2;
		if(n_symbols <= 1) return;

		var queue = Tunstall.prototype.queue;

		var end = 0; //keep track of queue end
		var pos = 0; //keep track of buffer first free space
		var n_words = 0;

		//Here probs will range from 0 to 0xffff for better precision
		for(var i = 0; i < n_symbols; i++)
			queue[i] = t.probs[2*i+1] << 8;

		var max_repeat = Math.floor((t.dictionary_size - 1)/(n_symbols - 1));
		var repeat = 2;
		var p0 = queue[0];
		var p1 = queue[1];
		var prob = (p0*p0)>>>16;
		while(prob > p1 && repeat < max_repeat) {
			prob = (prob*p0)>>> 16;
			repeat++;
		}

		if(repeat >= 16) { //Very low entropy results in large tables > 8K.
			t.table[pos++] = t.probs[0];
			for(var k = 1; k < n_symbols; k++) {
				for(var i = 0; i < repeat-1; i++)
					t.table[pos++] = t.probs[0];
				t.table[pos++] = t.probs[2*k];
			}
			t.starts[0] = (repeat-1)*n_symbols;
			for(var k = 1; k < n_symbols; k++)
				t.starts[k] = k;

			for(var col = 0; col < repeat; col++) {
				for(var row = 1; row < n_symbols; row++) {
					var off = (row + col*n_symbols);
					if(col > 0)
						queue[off] = (prob * queue[row]) >> 16;
					t.index[off] = row*repeat - col;
					t.lengths[off] = col+1;
				}
				if(col == 0)
					prob = p0;
				else
					prob = (prob*p0) >>> 16;
			}
			var first = ((repeat-1)*n_symbols);
			queue[first] = prob;
			t.index[first] = 0;
			t.lengths[first] = repeat;

			n_words = 1 + repeat*(n_symbols - 1);
			end = repeat*n_symbols;

		} else {
			//initialize adding all symbols to queues
			for(var i = 0; i < n_symbols; i++) {
				queue[i] = t.probs[i*2+1]<<8;
				t.index[i] = i;
				t.lengths[i] = 1;
	
				t.starts[i] = i;
				t.table[i] = t.probs[i*2];
			}
			pos = n_symbols;
			end = n_symbols;
			n_words = n_symbols;
		}

		//at each step we grow all queues using the most probable sequence
		while(n_words < t.dictionary_size) {
			//find highest probability word
			var best = 0;
			var max_prob = 0;
			for(var i = 0; i < n_symbols; i++) {
				var p = queue[t.starts[i]]; //front of queue probability.
				if(p > max_prob) {
					best = i;
					max_prob = p;
				}
			}
			var start = t.starts[best];
			var offset = t.index[start];
			var len = t.lengths[start];

			for(var i = 0; i < n_symbols; i++) {
				queue[end] = (queue[i] * queue[start])>>>16;
				t.index[end] = pos;
				t.lengths[end] = len + 1;
				end++;

				for(var k  = 0; k < len; k++)
					t.table[pos + k] = t.table[offset + k]; //copy sequence of symbols
				pos += len;
				t.table[pos++] = t.probs[i*2]; //append symbol
				if(i + n_words == t.dictionary_size - 1)
					break;
			}
			if(i == n_symbols)
				t.starts[best] += n_symbols; //move one column
			n_words += n_symbols -1;
		}


		var word = 0;
		for(i = 0, row = 0; i < end; i ++, row++) {
			if(row >= n_symbols)
				row  = 0;
			if(t.starts[row] > i) continue; //skip deleted words

			t.index[word] = t.index[i];
			t.lengths[word] = t.lengths[i];
			word++;
		}
	},
	_decompress: function(input, input_size, output, output_size) {
		//TODO optimize using buffer arrays
		var input_pos = 0;
		var output_pos = 0;
		if(this.probs.length == 2) {
			var symbol = this.probs[0];
			for(var i = 0; i < output_size; i++)
				output[i] = symbol;
			return;
		}

		while(input_pos < input_size-1) {
			var symbol = input[input_pos++];
			var start = this.index[symbol];
			var end = start + this.lengths[symbol];
			for(var i = start; i < end; i++) 
				output[output_pos++] = this.table[i];
		}

		//last symbol might override so we check.
		var symbol = input[input_pos];
		var start = this.index[symbol];
		var end = start + output_size - output_pos;
		var length = output_size - output_pos;
		for(var i = start; i < end; i++)
			output[output_pos++] = this.table[i];

		return output;
	}
}
