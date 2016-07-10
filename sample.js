'use strict';

var co      = require('co');

var Manga = require('./');

co(function *() {
    let manga = new Manga((yield Manga.findManga('Bleach'))[0].url, './Bleach');
    yield manga.getVolumes();
    yield manga.saveVolume(manga.volumes.length - 1);
}).catch(console.log);
