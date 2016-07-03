"use strict";

var fs      = require('fs');
var util    = require('util');
var jquery  = require('jquery');
var jsdom   = require('jsdom');
var request = require('request');
var co      = require('co');
var mkdirp  = require('mkdirp');
var child   = require('child_process');

var baseUrl = 'http://mangafox.me/manga';

class Manga {
    constructor (url, path, volumes) {
        if (url) {
            this.url = url;
        } else {
            throw new Error('URL required');
        }

        this.path = path || '~/Downloads';

        if (volumes) {
            this.volumes = volumes;
        }
        
        this.loading = {};
    }

    getVolumes () {
        let self = this;
        return co(function *() {
            let page = yield open(self.url);
            page.$.fn.reverse = [].reverse;
            let volumes = {};

            page.$('.chlist').reverse().each(function () {
                let chapters = page.$(this).find('li').reverse();
                let volume = page.$(chapters[0]).find('div * a').attr('href').replace(`${self.url}/`, '');
                let chap = volume.indexOf('/c');
                volume = chap !== -1 ? `${volume.slice(0, chap)}/` : '';
                volumes[volume] = [];
                chapters.each(function () {
                    let chapter = page.$(this).find('div * a').attr('href')
                        .replace(`${self.url}/${volume}c`, '');
                    volumes[volume].push(chapter.slice(0, chapter.indexOf('/1.html')));
                });
            });

            return self.volumes = volumes;
        });
    }

    saveVolumes (volumes, path) {
        if (path) {
            this.path = path;
        }

        let self = this;
        return co(function *() {
            if (volumes) {
                for (let volume of volumes) {
                    yield self.saveVolume(volume);
                }
            } else {
                for (let volume in self.volumes) {
                    if (self.volumes.hasOwnProperty(volume)) {
                        yield self.saveVolume(volume);
                    }
                }
            }
        })
    }

    saveVolume (volume) {
        this.loading[volume] = { done: 0, buffered: 0, total: 0 };
        let self = this;
        return co(function *() {
            let chapters = [];
            for (let chapter = 0; chapter < self.volumes[volume].length; chapter++) {
                chapters.push(self.saveChapter(volume, self.volumes[volume][chapter]));
            }
            yield Promise.all(chapters);
            delete self.loading[volume];
        })
    }

    saveChapter (volume, chapter) {
        let link = `${this.url}/${volume}c${chapter}`;
        let path = `${this.path}/Volume ${volume ? volume.slice(1) : '01/'}Chapter ${chapter}`;

        let self = this;
        return co(function *() {
            yield makePath(path);
            let page = yield open(`${link}/1.html`);

            let info = page.window.document.querySelector("#top_bar div div").textContent;
            page.window.close();
            page = null;
            let numberOfImages = info.slice(info.indexOf("of") + 3);
            self.loading[volume].total += (numberOfImages * 1);
            let images = [];
            for (let image = 1; image <= numberOfImages; image++) {
                images.push(new Promise(resolve => {
                    co(function *() {
                        let page = yield open(`${link}/${image}.html`);
                        let url = page.window.document.querySelector('#image').getAttribute('src');

                        page.window.close();
                        page = null;

                        ++self.loading[volume].buffered;
                        if (url.indexOf('.jpg') !== -1) {
                            let file = `${path}/${pad(image, 2)}.jpg`;
                            while(!(yield download(url, file))) {}
                        }

                        ++self.loading[volume].done;

                        resolve();
                    });
                }));
            }

            yield Promise.all(images);

            // console.log(`Volume ${volume} Chapter ${chapter}`);
        })
    }

    static findManga (title) {
        return co(function *() {
            let results = yield new Promise((resolve, reject) =>
                request({
                    uri: `http://mangafox.me/ajax/search.php?term=${title}`, json: true
                }, (err, res) => err ? reject(err) : resolve(res.body)));

            let manga = [];

            for (let info of results) {
                let url = `${baseUrl}/${info[2]}`;
                manga.push(open(url).then(page => {
                    let description = page.$('#title .summary').text();
                    return {
                        name: info[1],
                        url: url,
                        genre: info[3],
                        author: info[4],
                        image: page.$('#series_info .cover img').attr('src'),
                        description: description.slice(description.indexOf('\n') + 1).replace('\n', '')
                    };
                }));
            }

            return yield Promise.all(manga);
        });
    }
}

function open (page) {
    return co(function *() {
        let p;

        while (!(p = yield new Promise((resolve, reject) => {
            jsdom.env(page, (err, window) => {
                if (err) {
                    console.log(`Error opening page: ${page}`);
                    return resolve(null);
                }

                resolve({
                    $: jquery(window),
                    window: window
                });
            })
        }))) {}
        return p;
    });
}

function makePath (path) {
    return new Promise((resolve, reject) => mkdirp(path, err => err ? reject(err) : resolve()))
}

// In this context, we assume a successfully downloaded file to be greater than 1000 bytes
function download(url, file) {
    return co(function *() {
        let downloaded = yield new Promise(resolve => fs.access(file, err => resolve(!err)));
        if (!downloaded) {
            yield new Promise(resolve => {
                request({ url: url, encoding: null, timeout: 60000 }, (err, res, data) => {
                    if (err) {
                        console.log(`Request error [${err.code} | ${err.connect === true ? 'Connection' : 'Read'}] ${url}`);
                        downloaded = false;
                        return resolve();
                    }

                    fs.writeFile(file, data, (err) => {
                        if (err) {
                            console.log(`Error writing file: ${file}`);
                            downloaded = false;
                            return execute('rm', ['-rf', file]).then(resolve);
                        }

                        downloaded = true;
                        resolve();
                    });
                });
            });
        }

        return downloaded;
    })
}

function execute(command, args) {
    return new Promise((resolve, reject) => {
        let cmd = child.spawn(command, args);

        cmd
            .on('error', err => {
            console.log(err);
            resolve();
        })
            .on('close', resolve);

        cmd.stdout.on('data', res => resolve(res.toString()));
        cmd.stderr.on('data', err => {
            console.log(err.toString());
            resolve();
        });
    });
}

function pad(n, width, z) {
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

module.exports = Manga;
