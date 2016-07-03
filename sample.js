'use strict';

var co      = require('co');

var Manga = require('./');

co(function *() {
    let manga = new Manga((yield Manga.findManga('Bleach'))[0].url, './Bleach');

    yield manga.getVolumes();
    let loadingStarted = false;
    let interval = setInterval(function () {
        let loading = manga.loading['TBD'];
        if (loading) {
            loadingStarted = true;
            console.log(`${loading.done} Done ${loading.buffered} Buffered ${loading.total} Total`);
        } else if (loading) {
            console.log('Finished!');
            clearInterval(interval);
        }
    }, 3000);
    yield manga.saveVolume('TBD');
}).catch(console.log);