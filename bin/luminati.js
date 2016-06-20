#!/usr/bin/env node
// LICENSE_CODE ZON
'use strict'; /*jslint node:true, esnext:true*/
const _ = require('underscore');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const express = require('express');
const body_parser = require('body-parser');
const Luminati = require('../lib/luminati.js');
const glob = require('glob');
const net = require('net');
const request = require('request');
const humanize = require('humanize');
const moment = require('moment');
const prompt = require('prompt');
const http = require('http');
const netmask = require('netmask');
const socket_io = require('socket.io');
const socks = require('socksv5');
const hutil = require('hutil');
const util = require('util');
let sqlite3 = require('sqlite3');
const etask = hutil.etask;
const assign = Object.assign;
const is_win = process.platform=='win32';
const config_file = path.join(process.env.APPDATA||process.env.HOME||'/tmp',
    '.luminati.json');
const argv = require('yargs').usage('Usage: $0 [options] config1 config2 ...')
.alias({h: 'help'})
.describe({
    p: 'Listening port',
    log: `Log level (${Object.keys(Luminati.log_level).join('|')})`,
    customer: 'Customer',
    password: 'Password',
    proxy: 'Super proxy ip or country',
    proxy_count: 'Number of super proxies to use',
    secure_proxy: 'Use SSL when accessing super proxy',
    zone: 'Zone',
    country: 'Country',
    state: 'State',
    city: 'City',
    asn: 'ASN',
    dns: 'DNS resolving (local|remote)',
    pool_size: 'Pool size',
    ssl: 'Enable SSL sniffing',
    max_requests: 'Requests per session',
    session_timeout: 'Session establish timeout',
    direct_include: 'Include pattern for direct requests',
    direct_exclude: 'Exclude pattern for direct requests',
    www: 'Local web port',
    socks: 'SOCKS5 port (local:remote)',
    history: 'Log history',
    resolve: 'Reverse DNS lookup file',
    version: 'Display current luminati-proxy version',
})
.default({
    p: 24000,
    log: 'WARNING',
    customer: process.env.LUMINATI_CUSTOMER,
    password: process.env.LUMINATI_PASSWORD,
    zone: process.env.LUMINATI_ZONE||'gen',
    max_requests: 50,
    pool_size: 3,
    session_timeout: 5000,
    proxy_count: 1,
    www: 22999,
}).help('h').argv;
const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'))).version;
if (argv.version)
{
    console.log(`luminati-proxy version: ${version}`);
    process.exit();
}
const ssl = {
    key: fs.readFileSync(path.join(__dirname, 'server.key')),
    cert: fs.readFileSync(path.join(__dirname, 'server.crt')),
    ca: fs.readFileSync(path.join(__dirname, 'ca.crt')),
    requestCert: true,
    rejectUnauthorized: false,
};
const keys = ['zone', 'country', 'state', 'city', 'asn', 'max_requests',
      'pool_size', 'session_timeout', 'direct_include', 'direct_exclude',
      'dns', 'resolve', 'cid', 'password'];
let opts = _.pick(argv, keys.concat('log'));
if (opts.resolve)
{
    if (typeof opts.resolve=='boolean')
    {
        opts.resolve = ip=>etask(function*(){
            let domains = yield etask.nfn_apply(dns, '.reverse', [ip]);
            log('DEBUG', `dns resolve ${ip} => ${domains}`);
            return domains&&domains.length?domains[0]:ip;
        });
    }
    else
    {
        const domains = {};
        hutil.file.read_lines_e(opts.resolve).forEach(line=>{
            const m = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([^\s]+)/);
            if (!m)
                return;
            log('DEBUG', `dns entry: ${m[1]} => ${m[2]}`);
            domains[m[1]] = m[2];
        });
        opts.resolve = ip=>domains[ip]||ip;
    }
}
let hosts;
if (argv.log=='DEBUG')
    sqlite3 = sqlite3.verbose();
let db;
if (is_win)
{
    const readline = require('readline');
    readline.createInterface({input: process.stdin, output: process.stdout})
        .on('SIGINT', ()=>process.emit('SIGINT'));
}
process.on('SIGINT', ()=>db ? db.close(()=>process.exit()) : process.exit());

const dot2num = dot=>{
    const d = dot.split('.');
    return ((((((+d[0])*256)+(+d[1]))*256)+(+d[2]))*256)+(+d[3]);
};

function sql(){
    const args = [].slice.call(arguments);
    return etask(function*(){
        return yield etask.nfn_apply(db, '.all', args); });
}

let config = argv._.reduce((config, pattern)=>{
    glob.sync(pattern).concat(config_file)
    .filter(filename=>{
        try {
            fs.accessSync(filename, fs.F_OK);
        } catch(err){ return false; }
        return true;
    })
    .forEach(filename=>{
        [].push.apply(config, [].concat(JSON.parse(fs.readFileSync(filename,
            {encoding: 'utf8'}))).map(conf=>assign({}, opts, conf)));
    });
    return config;
}, []);
config = config.length && config || [opts];
config.filter(conf=>!conf.port)
    .forEach((conf, i)=>assign(conf, {port: argv.p+i}));

function log(level, msg, extra){
    if (Luminati.log_level[level]>Luminati.log_level[argv.log])
        return;
    let args = [`${level}: ${msg}`];
    if (extra)
        args.push(extra);
    console.log.apply(console, args);
}

const json = opt=>etask(function*(){
    if (typeof opt=='string')
        opt = {url: opt};
    opt.json = true;
    let res = yield etask.nfn_apply(request, [opt]);
    log('DEBUG', `GET ${opt.url} - ${res.statusCode}`);
    return res;
});

const check_credentials = ()=>etask(function*(){
    prompt.message = 'Luminati credentials';
    let cred = {};
    for (let i=0; i<config.length; i++)
    {
        cred.customer = config[i].customer||cred.customer;
        cred.password = config[i].password||cred.password;
        if (cred.customer && cred.password)
            break;
    }
    cred.customer = argv.customer||cred.customer;
    cred.password = argv.password||cred.password;
    prompt.override = cred;
    prompt.start();
    return assign(argv, yield etask.nfn_apply(prompt, '.get', [[{
        name: 'customer',
        description: 'CUSTOMER',
        required: true,
    }, {
        name: 'password',
        description: 'PASSWORD',
        required: true,
    }]]));
});

const prepare_database = ()=>etask(function*(){
    yield etask.nfn_apply((fn, cb)=>db = new sqlite3.Database(fn, cb), null,
        [path.join(os.homedir(), '.luminati.sqlite3'.substr(is_win?1:0))]);
    const tables = {
        ip: {
            ip: {type: 'UNSIGNED INTEGER', primary: true},
            timestamp: {type: 'INTEGER', default: 'CURRENT_TIMESTAMP'},
        },
        request: {
            url: 'TEXT',
            method: 'TEXT',
            request_headers: 'TEXT',
            response_headers: 'TEXT',
            status_code: {type: 'INTEGER', index: true},
            timestamp: 'INTEGER',
            elapsed: 'INTEGER',
            timeline: 'TEXT',
            proxy: 'TEXT',
            username: 'TEXT',
        },
    };
    for (let table in tables)
    {
        const fields = [], queries = [];
        for (let field in tables[table])
        {
            const value = tables[table][field];
            if (typeof value=='string')
                return fields.push(field+' '+value);
            if (value.primary)
                return fields.push(field+' '+value.type+' PRIMARY KEY');
            let def = field+' '+value.type;
            if (value.default)
                def += ' DEFAULT '+value.default;
            fields.push(def);
            if (value.index)
            {
                queries.push(util.format('CREATE %s INDEX IF NOT EXISTS %s '+
                    'ON %s(%s)', value.unique&&'UNIQUE'||'', field, table,
                    field));
            }
        }
        queries.unshift(util.format('CREATE TABLE IF NOT EXISTS %s(%s)', table,
            fields.join(', ')));
        for (let i=0; i<queries.length; i++)
        {
            log('DEBUG', queries[i]);
            yield sql(queries[i]);
        }
    }
});

const resolve_super_proxies = ()=>etask(function*(){
    const hosts = [].concat(argv.proxy||'zproxy.luminati.io')
    .map(host=>etask(function*(){
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host))
        {
            log('DEBUG', `using super proxy ${host}`);
            return host;
        }
        let prefix = '';
        if (host.length==2)
        {
            prefix = `servercountry-${host}-`;
            host = 'zproxy.luminati.io';
        }
        const hosts = {};
        const timestamp = Date.now();
        while (Object.keys(hosts).length<argv.proxy_count &&
            Date.now()-timestamp<30000)
        {
            let domain = `${prefix}session-${Date.now()}.${host}`;
            let ips = yield etask.nfn_apply(dns, '.resolve', [domain]);
            log('DEBUG', `resolving ${domain}`, ips);
            ips.forEach(ip=>hosts[ip] = true);
        }
        return Object.keys(hosts);
    }));
    return [].concat.apply([], yield etask.all(hosts));
});

const create_proxy = (conf, port)=>etask(function*(){
    conf.proxy = [].concat(conf.proxy);
    if (conf.direct_include || conf.direct_exclude)
    {
        conf.direct = {};
        if (conf.direct_include)
            conf.direct.include = new RegExp(conf.direct_include, 'i');
        if (conf.direct_exclude)
            conf.direct.exclude = new RegExp(conf.direct_exclude, 'i');
        delete conf.direct_include;
        delete conf.direct_exclude;
    }
    const server = new Luminati(assign(_.pick(argv, 'customer', 'password'),
        conf, {ssl: conf.ssl&&ssl}));
    return yield server.listen(port);
});

const create_proxies = hosts=>{
    return etask.all(config.map(conf=>create_proxy(assign(conf, {
        proxy: conf.proxy||hosts,
        ssl: argv.ssl,
        secure_proxy: argv.secure_proxy,
    }))));
};

const create_api_interface = ()=>{
    const app = express();
    app.get('/stats', (req, res, next)=>etask(function*(){
        let r = yield json({
            url: 'https://luminati.io/api/get_customer_bw?details=1',
            headers: {'x-hola-auth':
                `lum-customer-${argv.customer}-zone-gen-key-${argv.password}`},
        });
        res.json(r.body[argv.customer]||{});
    }));
    const proxies = {};
    app.get('/creds', (req, res)=>{
        res.json({customer: argv.customer, password: argv.password}); });
    app.post('/creds', (req, res)=>{
        argv.customer = req.body.customer||argv.customer;
        argv.password = req.body.password||argv.password;
        res.sendStatus(200);
    });
    app.post('/create', (req, res, next)=>etask(function*(){
        this.on('ensure', ()=>{
            if (this.error)
                return next(this.error);
        });
        req.body.proxy = hosts;
        let key = Object.keys(req.body);
        keys.forEach(field=>{
            if (!req.body[field])
                return delete req.body[field];
            key.push(field+'-'+req.body[field]);
        });
        key = key.join('-');
        let server = proxies[key];
        if (server)
        {
            if (server.port)
                return res.json({port: server.port});
            return server.once('ready', ()=>res.json({port: server.port}));
        }
        server = proxies[key] = yield create_proxy(_.omit(req.body, 'timeout'),
	    req.body.port||0);
        if (req.body.timeout)
        {
            server.on('idle', idle=>{
                if (server.timer)
                {
                    clearTimeout(server.timer);
                    delete server.timer;
                }
                if (!idle)
                    return;
                server.timer = setTimeout(()=>etask(function*(){
                    yield server.stop();
                    delete proxies[key];
                }), +req.body.timeout);
            });
        }
        res.json({port: server.port});
    }));
    app.post('/delete', (req, res, next)=>etask(function*(){
        this.on('ensure', ()=>{
            if (this.error)
                return next(this.error);
        });
        const ports = (req.body.port||'').split(',');
        for (let i=0; i<ports.length; i++)
        {
            let port = +ports[i].trim();
            if (!port)
                continue;
            for (let key in proxies)
            {
                let server = proxies[key];
                if (server.port!=port)
                    continue;
                if (server.timer)
                    clearTimeout(server.timer);
                yield server.stop();
                delete proxies[key];
                break;
            }
        }
        res.status(204).end();
    }));
    app.post('/block', (req, res, next)=>etask(function*(){
        this.on('ensure', ()=>{
            if (this.error)
                return next(this.error);
        });
        assert(req.body.ip, 'missing ip');
        let ips = [];
        [].concat(req.body.ip).forEach(ip=>{
            const block = new netmask.Netmask(ip);
            block.forEach((ip, long)=>{
                ips.push(long);
            });
        });
        yield sql(`INSERT INTO ip(ip) VALUES(${ips.join(',')})`);
        res.json({count: ips.length});
    }));
    return app;
};

const create_web_interface = proxies=>etask(function*(){
    const timestamp = Date.now();
    const app = express();
    const server = http.Server(app);
    const io = socket_io(server);
    assign(app.locals, {humanize: humanize, moment: moment});
    app.use(body_parser.urlencoded({extended: true}));
    app.use(body_parser.json());
    app.use('/api', create_api_interface());
    app.use((req, res, next)=>{
        res.locals.path = req.path;
        next();
    });
    app.get('/version.json', (req, res, next)=>{
      res.json({version});
    });
    app.get('/stats.json', (req, res, next)=>etask(function*stats(){
        let r = yield json({
            url: 'https://luminati.io/api/get_customer_bw?details=1',
            headers: {'x-hola-auth':
                `lum-customer-${argv.customer}-zone-gen-key-${argv.password}`},
        });
	res.json(r.body[argv.customer]||{});
    }));
    app.get('/stats', (req, res, next)=>etask(function*(){
        let r = yield json({
            url: 'https://luminati.io/api/get_customer_bw?details=1',
            headers: {'x-hola-auth':
                `lum-customer-${argv.customer}-zone-gen-key-${argv.password}`},
        });
        res.render('stats', {stats: r.body[argv.customer]||{}});
    }));
    app.use(express.static(path.join(__dirname, 'public')));
    app.use('/hutil', express.static(path.join(__dirname,
        '../node_modules/hutil/util')));
    app.use((err, req, res, next)=>{
        log('ERROR', err.stack);
        res.status(500).send('Server Error');
    });
    io.on('connection', socket=>etask(function*(){
        io.emit('proxies', proxies.map(p=>({port: p.port, opt: p.opt})));
        const notify = (name, value)=>{
            const data = {};
            data[name] = value;
            io.emit('health', data);
        };
        try {
            yield json('http://lumtest.com/myip');
            notify('network', true);
        } catch(e){ notify('network', false); }
        try {
            yield json('http://zproxy.luminati.io:22225/');
            notify('firewall', true);
        } catch(e){ notify('firewall', false); }
        try {
            let res = yield json({
                url: 'http://zproxy.luminati.io:22225/',
                headers: {'x-hola-auth':
                    `lum-customer-${argv.customer}-zone-gen-key-${argv.password}`},
            });
            notify('credentials', res.statusCode!=407);
        } catch(e){ notify('credentials', false); }
    }));
    setInterval(()=>{
        const stats = {};
        proxies.forEach(proxy=>stats[proxy.port] = proxy.stats);
        io.emit('stats', stats);
    }, 1000);
    server.on('error', err=>this.ethrow(err));
    yield etask.cb_apply(server, '.listen', [argv.www]);
    return server;
});

const create_socks_server = (local, remote)=>etask(function*(){
    const server = socks.createServer((info, accept, deny)=>{
        if (info.dstPort==80)
        {
            info.dstAddr = '127.0.0.1';
            info.dstPort = remote;
	    log('DEBUG', 'Socks http connection: ', info);
            return accept();
        }
        if (info.dstPort==443)
        {
            const socket = accept(true);
            const dst = net.connect(remote, '127.0.0.1');
	    log('DEBUG', 'Socks https connection: ', info);
            dst.on('connect', ()=>{
                dst.write(util.format('CONNECT %s:%d HTTP/1.1\r\n'+
                    'Host: %s:%d\r\n\r\n', info.dstAddr, info.dstPort,
                    info.dstAddr, info.dstPort));
                socket.pipe(dst);
            });
            return dst.once('data', ()=>{ dst.pipe(socket); });
        }
	log('DEBUG', 'Socks connection: ', info);
        accept();
    });
    server.useAuth(socks.auth.None());
    yield etask.cb_apply(server, '.listen', [local]);
    return server;
});

etask(function*(){
    try {
        yield check_credentials();
        yield prepare_database();
        hosts = yield resolve_super_proxies();
        const proxies = yield create_proxies(hosts);
        proxies.forEach(server=>log('DEBUG', 'local proxy', server.opt));
        if (argv.history)
        {
            var stmt = db.prepare('INSERT INTO request (url, method, '
                +'request_headers, response_headers, status_code, timestamp, '
                +'elapsed, timeline, proxy, username) VALUES (?,?,?,?,?,?,?,?,'
                +'?,?)');
            proxies.forEach(server=>{
                server.on('response', res=>{
                    log('DEBUG', util.inspect(res, {depth: null, colors: 1}));
                    const req = res.request;
                    stmt.run(req.url, req.method, JSON.stringify(req.headers),
                        JSON.stringify(res.headers), res.status_code,
                        Math.floor(res.timeline.start/1000), res.timeline.end,
                        JSON.stringify(res.timeline), res.proxy.host,
                        res.proxy.username);
                });
            });
        }
        if (argv.www)
        {
            const server = yield create_web_interface(proxies);
            let port = server.address().port;
            console.log(`admin is available at http://127.0.0.1:${port}`);
        }
        [].concat(argv.socks||[]).forEach(ports=>etask(function*(){
            ports = ports.split(':');
            const server = yield create_socks_server(+ports[0], +ports[1]);
            let port = server.address().port;
            console.log(`SOCKS5 is available at 127.0.0.1:${port}`);
        }));
    } catch(e){
        if (e.message!='canceled')
            console.log(e, e.stack);
    }
});
