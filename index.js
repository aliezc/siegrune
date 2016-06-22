'use strict';

var Emitter = require('emitter-lite');
var http = require('http');
var fs = require('fs');
var assert = require('assert');
var url = require('url');
var qs = require('querystring');
var path = require('path');
var zlib = require('zlib');
var mimez = require('mimez');

var SiegruneAPI = {
	setHeaders : function(res, obj){
		for(var i in obj){
			res.setHeader(i, obj[i]);
		}
	},
	
	parseRange : function(str){
		assert('string' == typeof str, 'Invalid argument');
		var arr = str.split('-');
		return arr[1] == '' ? {start: +arr[0] || 0} : {start: +arr[0] || 0, end: +arr[1]};
	},
	
	getArgName: function(str){
		assert('string' == typeof str, 'Invalid argument');
		
		var tmp = str.match(/\$[a-zA-Z0-9_]*/g);
		var arr = [];
		try{
			for(var i = 0; i < tmp.length; i++) arr[i] = tmp[i].slice(1);
		}catch(e){
			return [];
		}
		
		return arr;
	},
	
	getArgValue: function(req, str){
		assert('string' == typeof req && 'string' == typeof str, 'Invalid argument');
		
		str = str.replace(/\/\$[a-zA-Z0-9_]*/g, '/(.*)');
		str = str.replace(/\//g, '\\/');
		
		try{
			var result = req.match(new RegExp('^' + str + '$')).slice(1);
		}catch(e){
			return [];
		}
		return result;
	}
};

var Siegrune = function(){
	Emitter.apply(this, arguments);
	
	// 域名
	this.hostname = [];
	
	// 端口
	this.port = 8000;
	
	// 路由规则
	this.route = [];
	
	// 服务器
	this._server = http.createServer();
	
	// 渲染器
	this.renderer = function(view, args, cb){
		var res = this;
		fs.readFile(view, function(err, buf){
			if(err){
				res.statusCode = 403;
				res.send(new Buffer('403 - Forbidden'));
				if(typeof cb == 'function') cb.call(null, new Error('Read File Error'));
				return;
			}else{
				var str = buf.toString();
				if('object' == typeof args){
					for(var i in args){
						var reg = new RegExp('\\{\\$' + i + '\\}', 'gm');
						str = str.replace(reg, args[i]);
					}
				}
				
				res.send(new Buffer(str));
				if(typeof cb == 'function') cb.call(null);
				return;
			}
		});
	}
}

// 添加域名
Siegrune.prototype.addHost = function(str){
	assert.equal('string', typeof str);
	this.hostname.push(str.toLowerCase());
	return this;
}

// 设置端口
Siegrune.prototype.setPort = function(port){
	assert.equal('number', typeof port);
	this.port = port;
	return this;
}

// 添加路由记录
Siegrune.prototype.add = function(){
	// string, string, function
	// string, regexp, function
	// string, string, string
	// string, function
	// regexp, function
	// string, string
	
	assert(arguments.length > 1);
	var method = 'GET', matcher = '/', handle;
	
	if(arguments.length == 3){
		assert('string', typeof arguments[0]);
		assert('string' == typeof arguments[1] || arguments[1] instanceof RegExp);
		assert('function' == typeof arguments[2] || 'string' == typeof arguments[2]);
		method = arguments[0].toUpperCase();
		matcher = arguments[1];
		handle = arguments[2];
	}else if(arguments.length == 2){
		assert('string' == typeof arguments[0] || arguments[0] instanceof RegExp);
		assert('function' == typeof arguments[1] || 'string' == typeof arguments[1]);
		matcher = arguments[0];
		handle = arguments[1];
	}
	
	this.route.push({
		method: method,
		matcher: matcher,
		handle: handle
	});
	return this;
}

// 添加get记录
Siegrune.prototype.get = function(matcher, handle){
	this.add('GET', matcher, handle);
}

// 添加post记录
Siegrune.prototype.post = function(matcher, handle){
	this.add('POST', matcher, handle);
}

// 设置渲染器
Siegrune.prototype.setRenderer = function(cb){
	assert(typeof cb == 'function', 'Invalid renderer type');
	this.renderer = cb;
}

// 监听端口
Siegrune.prototype.listen = function(){
	var route = this.route;
	var hostname = this.hostname;
	var renderer = this.renderer;
	this._server.on('request', function(req, res){
		var host = req.headers['host'] || '';
		
		if(hostname.length == 0 || hostname.indexOf(host) != -1){
			// 域名匹配
			var matched;
			
			// 开始匹配路由
			for(var i = 0; i < route.length; i++){
				if(route[i].method != req.method && req.method != 'GET' && req.method != 'HEAD'){
					continue;
				}
				var request = url.parse(req.url).pathname;
				
				if(route[i].matcher instanceof RegExp){
					var result = request.match(route[i].matcher);
					if(result){
						var tmp = result.length > 1 ? result.slice(1) : [];
						req.REQUEST = tmp;
						res.statusCode = 200;
						matched = route[i].handle;
					}
				}else{
					var str = route[i].matcher.replace(/\//g, '\\/');
					str = str.replace(/\/\$[a-zA-Z0-9_]*/g, '/.*');
					if(new RegExp('^' + str + '$').test(request)){
						var name = SiegruneAPI.getArgName(route[i].matcher);
						var val = SiegruneAPI.getArgValue(request, route[i].matcher);
						var tmp = {};
						for(var j = 0; j < name.length; j++) tmp[name[j]] = val[j];
						req.REQUEST = tmp;
						res.statusCode = 200;
						matched = route[i].handle;
					}
				}
				
				if(matched) break;
			}
			
			if(matched){
				var urlobj = url.parse(req.url);
				
				// 添加mime类型方法
				res.mime = function(ext){
					if('string' == typeof ext){
						res.setHeader('content-type', mimez.ext(ext));
					}else{
						res.setHeader('content-type', mimez.ext('xxx'));
					}
				}
				res.setHeader('content-type', mimez.url(urlobj.path));
				
				// 添加响应方法
				res.send = function(){
					assert(arguments.length ==2 || arguments.length == 1, 'Invalid arguments');
					
					var options = {}, data = new Buffer('');
					if(arguments.length == 2){
						options = arguments[0];
						data = arguments[1];
					}else{
						data = arguments[0];
					}
					
					if(req.headers.range){
						options.range = SiegruneAPI.parseRange(req.headers.range);
					}
					
					assert('object' == typeof options, 'Invalid options');
					assert('string' == typeof data || data instanceof Buffer, 'Invalid data');
					
					res.statusCode = options.code || 200;
					if('object' == typeof options.headers) SiegruneAPI.setHeaders(res, options.headers);
					
					if('string' == typeof data){
						fs.stat(data, function(err, stat){
							if(err){
								res.statusCode = 404;
								res.end('');
								return;
							}
							
							// res.setHeader('content-length', stat.size);
							var frs = options.range ? fs.createReadStream(data, options.range) : fs.createReadStream(data);
							
							if(options.range){
								res.setHeader('content-range', '' + (options.range.start || '0') + '-' + (options.range.end || stat.size) + '/' + stat.size);
								res.statusCode = 206;
								// res.setHeader('content-length', '' + (options.range.end || stat.size) - (options.range.start || 0));
							}
							
							if(options.encoding){
								var enc = options.encoding.match(/(gzip|deflate)/);
								if(enc){
									if(enc[0] == 'gzip'){
										frs.pipe(zlib.createGzip()).pipe(res);
									}else{
										frs.pipe(zlib.createDeflate()).pipe(res);
									}
								}else{
									frs.pipe(res);
								}
							}else{
								frs.pipe(res);
							}
						});
					}else{
						// res.setHeader('content-length', data.length);
						if('object' == typeof options.range){
							res.setHeader('content-range', '' + (options.range.start || '0') + '-' + (options.range.end || data.length) + '/' + data.length);
							data = data.slice(options.range.start || 0, options.range.end || data.length);
							res.statusCode = 206;
							// res.setHeader('content-length', '' + (options.range.end || data.length) - (options.range.start || 0))
						}
						
						if('string' == typeof options.encoding){
							var enc = options.encoding.match(/(gzip|deflate)/);
							if(enc){
								res.setHeader('content-encoding', enc[0]);
								zlib[enc[0]].call(this, data, function(err, result){
									assert(!err, err.message);
									
									res.end(result);
								});
							}else{
								res.end(data);
							}
						}else{
							res.end(data);
						}
					}
				};
				
				// 添加静态路由
				res.dir = function(dir){
					assert(typeof dir == 'string', 'Invalid dir type');
					if(typeof req.REQUEST[0] != 'string'){
						res.statusCode = 500;
						res.send(new Buffer(''));
						return;
					}
					
					var file = req.REQUEST[0].replace('../', '');
					file = path.join(dir, file);
					res.send(file);
				}
				
				// 请求字符串
				req.QUERY = urlobj.query ? qs.parse(urlobj.query) : {};
				
				// 添加渲染器
				res.render = function(){
					renderer.apply(res, arguments);
				}
				
				// 处理请求
				if('string' == typeof matched){
					res.send(matched);
				}else{
					matched.call(this, req, res);
				}
			}else{
				res.statusCode = 404;
				res.end();
			}
		}else{
			res.statusCode(502);
			res.setHeader('date', new Date().toUTCString());
			res.end();
		}
	}).on('error', function(err){
		console.log('Error: ' + new Date().toUTCString() + ' ' + err);
	}).listen(this.port);
};

module.exports = {
	Siegrune: Siegrune,
	createServer: function(){
		return new Siegrune();
	}
};