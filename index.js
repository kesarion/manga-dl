"use strict";

const fs         = require('fs');
const util       = require('util');
const child      = require('child_process');
const htmlparser = require("htmlparser2");
const domutils   = require("domutils");
const request    = require('request');
const co         = require('co');
const mkdirp     = require('mkdirp');

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
    }

    getVolumes () {
        let self = this;
        return co(function *() {
            let dom = yield getDom(self.url);

            self.volumes = [];
            for (let volume of domutils.findAll(elem => elem.attribs.class === 'chlist', dom).reverse()) {
                let chapters = [];
                let anchors = domutils.findAll(elem => elem.attribs.href && elem.attribs.href.indexOf(self.url) >= 0, volume.children).reverse();
                let name = anchors[0].attribs.href.replace(`${self.url}/`, '');
                let chapter = name.indexOf('/c');
                name = chapter >= 0 ? `${name.slice(0, chapter)}/` : '';

                for (let anchor of anchors) {
                    chapters.push(anchor.attribs.href.replace(`${self.url}/${name}c`, '').slice(0, -7));
                }

                self.volumes.push({
                    name: name,
                    chapters: chapters,
                    loading: null
                });
            }

            return self.volumes;
        });
    }

    saveVolumes (volumes, path) {
        if (path) {
            this.path = path;
        }

        let self = this;
        return co(function *() {
            if (!volumes) {
                volumes = [];
                for (let index = 0; index < self.volumes.length; index++) {
                    volumes.push(index);
                }
            }

            let promises = [];
            for (let volume of volumes) {
                promises.push(self.saveVolume(volume));
            }

            yield Promise.all(promises);
        })
    }

    saveVolume (index) {
        let volume = this.volumes[index];
        volume.loading = { done: 0, buffered: 0, total: 0 };
        let self = this;
        return co(function *() {
            let promises = [];
            for (let chapter of volume.chapters) {
                promises.push(self.saveChapter(volume, chapter));
            }
            yield Promise.all(promises);
            volume.loading = null;
        })
    }

    saveChapter (volume, chapter) {
        let link = `${this.url}/${volume.name}c${chapter}`;
        let path = `${this.path}/Volume ${volume.name ? volume.name.slice(1) : '01/'}Chapter ${chapter}`;

        let self = this;
        return co(function *() {
            yield makePath(path);

            let info = null;

            while (!info) {
                let dom = yield getDom(`${link}/1.html`);
                info = domutils.findOne(elem => elem.name == 'div' && elem.parent.parent.attribs.id == 'top_bar', dom);
            }

            info = info.children;
            info = info[info.length - 1].data;
            let images = info.slice(info.indexOf("of") + 3, -3);
            volume.loading.total += (images * 1);
            let promises = [];
            for (let image = 1; image <= images; image++) {
                promises.push(new Promise(resolve => co(function *() {
                    let img = null;

                    while (!img) {
                        let dom = yield getDom(`${link}/${image}.html`);
                        img = domutils.findOne(elem => elem.name == 'img' && elem.attribs.id == 'image', dom);
                    }

                    let url = img.attribs.src;

                    ++volume.loading.buffered;
                    if (url.indexOf('.jpg') !== -1) {
                        let file = `${path}/${pad(image, 2)}.jpg`;

                        while(!(yield download(url, file))) {}
                    }

                    ++volume.loading.done;

                    resolve();
                    })
                ));
            }

            yield Promise.all(promises);

            //console.log(`Volume ${volume} Chapter ${chapter}`);
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
                manga.push(getDom(url).then(dom => {
                    let summary = domutils.findOne(elem => elem.name == 'p' && elem.attribs.class && elem.attribs.class.indexOf('summary') >= 0, dom);
                    let cover = domutils.findOne(elem => elem.name == 'img' && elem.parent.attribs.class && elem.parent.attribs.class.indexOf('cover') >= 0, dom);
                    return {
                        name: info[1],
                        url: url,
                        genre: info[3],
                        author: info[4],
                        image: cover ? cover.attribs.src : '',
                        description: summary ? summary.children[0].data : ''
                    };
                }).catch(console.log));
            }

            return yield Promise.all(manga);
        });
    }
}

function getDom (url) {
    return co(function *() {
        let dom;

        while (!(dom = yield new Promise(resolve => {
            request({ url: url, gzip: true }, (err, res, body) => {
                if (err) {
                    console.log('Request ERROR: ' + err);
                    return resolve(null);
                }

                let handler = new htmlparser.DomHandler((err, dom) => {
                    if (err) {
                        console.log('DOM ERROR: ' + err);
                        return resolve(null);
                    }

                    resolve(dom);
                });

                let parser = new htmlparser.Parser(handler);
                parser.write(body);
                parser.done();
            });
        }))) {}

        return dom;
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
                request({ url: url, encoding: null, gzip: true, timeout: 60000 }, (err, res, data) => {
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

/*function open (page) {
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
 }*/