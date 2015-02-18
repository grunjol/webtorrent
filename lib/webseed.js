module.exports = Webseed
var BLOCK_LENGTH = 16 * 1024
var BlockStream = require('block-stream')
var EventEmitter = require('events').EventEmitter
var inherits = require('inherits')
var request = require('request')
var debug = require('debug')('webtorrent:webseed')

var RESERVE_SIZE_BLOCKS = 32 * 32
var MAX_RESERVE_PIECES = 0

var STATUS_INIT = 0
var STATUS_READY = 1
var STATUS_RUN = 2
var STATUS_DONE = 3

inherits(Webseed, EventEmitter)

function Webseed (torrent) {
  var self = this
  self.torrent = torrent
  self.url = null

  if (torrent.parsedTorrent.urlList && torrent.parsedTorrent.urlList[0]) {
    // try the first from torrent
    self.url = torrent.parsedTorrent.urlList[0]
  } else if (torrent.parsedTorrent.as && torrent.parsedTorrent.as) {
    // try from as magnet param
    self.url = torrent.parsedTorrent.as
  }

  self.torrent.once('ready', function() {
    self.storage = torrent.storage
    if (self.url) {
      self.start()
    } else {
      debug('no web seeding')
    }
  })
}

Webseed.prototype.start = function() {
  var self = this

  if (!self.url) return false

  self.on('ready', self.startDownload.bind(self))

  self.storage.on('critical', function(firstPiece, lastPiece) {
    debug('critical: %d', firstPiece)

    if ((self.status === STATUS_RUN && (firstPiece > self.lastPiece.index || firstPiece < self.piece.index))
    || self.status === STATUS_DONE) {
      debug('critical outside download window: %d - %d', self.piece.index, self.lastPiece.index)
      self.criticalPiece = firstPiece
      self.abort()
    }
  })

  self.storage.once('warning', self.abort.bind(self))

  process.nextTick(function () {
    self.emit('ready')
  })

  return true
}

Webseed.prototype.startDownload = function() {
  var self = this

  if (self.status === STATUS_RUN) return

  self.initializeReserve()

  if (self.status === STATUS_DONE) return

  for (var j = 0; j < RESERVE_SIZE_BLOCKS; j++) {
    if (!self.expandReserve()) {
      debug('short initial reserve')
      break
    }
  }

  debug('starting with reserve: %d : %d - %d : %d', self.piece.index, self.offset, self.lastPiece.index, self.lastReserve.offset)

  self.downloadReserved()
}

Webseed.prototype.initializeReserve = function() {
  var self = this

  self.status = STATUS_INIT

  var reserve = null
  var piece = null
  // check for critical piece or begining
  var start = (typeof self.criticalPiece === 'undefined') ? 0 : self.criticalPiece
  for (var i = start; i < self.storage.pieces.length; i++) {
    if (!self.storage.bitfield.get(i) && (reserve = self.storage.reserveBlock(i))) {
      piece = self.storage.pieces[i]
      break
    }
  }

  if (piece) {
    self.initialPiece = piece
    self.lastPiece = piece
    self.piece = piece
    self.offset = reserve.offset
    self.lastReserve = reserve
  } else {
    self.status = STATUS_DONE
  }
}

Webseed.prototype.expandReserve = function() {
  var self = this

  var current = self.lastPiece.index
  var next = current
  var nextOffset = self.lastReserve.offset + self.lastReserve.length
  // if last reserve was last block in piece move to next piece
  if (nextOffset === self.lastPiece.length) {
    next = current + 1
    nextOffset = 0
  }

  if (MAX_RESERVE_PIECES && self.lastPiece.index - self.initialPiece.index > MAX_RESERVE_PIECES) {
    debug('this thread had enough')
    return false
  }

  var reserve = self.storage.reserveBlock(next)
  if (reserve) {
    // check if contiguous
    if (reserve.offset === nextOffset) {
      if (next > current) {
        self.lastPiece = self.storage.pieces[next]
        self.lastPiece.on('done', function() {debug('verfied %d', self.lastPiece.index)})
      }
      self.lastReserve = reserve
      return true
    } else {
      self.storage.cancelBlock(next, reserve.offset)
    }
  }

  return false
}

Webseed.prototype.downloadReserved = function() {
  var self = this
  // var firstByte = self.storage.pieceLength * self.piece.index + self.offset
  var firstByte = self.storage.pieces[0].blocks.length * BLOCK_LENGTH * self.piece.index + self.offset

  self.status = STATUS_RUN

  var options = {
    headers: {
      range: 'bytes=' + firstByte + '-'
    },
    uri: self.url
  }

  debug(options)
  self.request = request(options)

  self.request.pipe(new BlockStream(BLOCK_LENGTH).on('data', self.write.bind(self)))
}

Webseed.prototype.write = function(block) {
  var self = this

  if (!self.piece || isNaN(self.piece.index)) {
    debug('discarding extra block')
    self.abort()
    return
  }

  if (!self.offset) debug('writing: ' + block.length + ' ' + self.piece.index + ' ' + self.offset)
  self.piece.writeBlock(self.offset, block, function(err) {if (err) debug(err)})
  if (!self.increment(block.length)) {
    if (self.reserveExhausted()) {
      debug('--------> Abort!')
      self.abort()
    }
  } else {
    // debug('incremented: %d : %d', self.piece.index, self.offset)
    self.expandReserve()
  }
}

Webseed.prototype.increment = function(incr) {
  var self = this
  var nextOffset = self.offset + incr

  if (nextOffset < self.piece.length) {
    self.offset = nextOffset
    return true
  } else {
    if (self.piece.index < self.lastPiece.index) {
      self.piece = self.storage.pieces[self.piece.index + 1]
      self.offset = 0
      return true
    } else {
      self.piece = {index: NaN}
      self.offset = 0
    }
  }
  return false
}

Webseed.prototype.reserveExhausted = function() {
  var self = this
  return (isNaN(self.piece.index) || self.piece.index > self.lastPiece.index ||
    (self.piece.index === self.lastPiece.index && self.offset >= self.lastReserve.offset))
}

Webseed.prototype.cancelAbortedReserves = function() {
  var self = this
  for (var i = self.piece.index; i <= self.lastPiece.index; i++) {
    if (!self.storage.bitfield.get(i)) {
      debug('cancelling blocks for piece: %d', i)
      var piece = self.storage.pieces[i]
      for (var j = 0; j < piece.blocks.length; j++) {
        piece.cancelBlock(j * BLOCK_LENGTH)
      }
    }
  }
}

Webseed.prototype.abort = function() {
  var self = this
  self.request.abort()
  self.cancelAbortedReserves()
  self.status = STATUS_READY
  process.nextTick(function () {
    self.emit('ready')
  })
}
