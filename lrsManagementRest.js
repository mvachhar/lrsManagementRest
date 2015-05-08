// Author: toejough (https://github.com/toejough)
// Contributors:
//   adrian (https://github.com/adrian)
//   mvachhar (https://github.com/mvachhar)

// [Use Strict JS]
"use strict";

// [Requires]
// Node.js  Modules
var http   = require('http');
var events = require('events');
var util   = require('util');

// unix domain socket name to connect to local REST server
var unixSockName = "/tmp/rest_server/http.sock";

/**
 * Overwrites obj1's values with obj2's and adds obj2's if non existent in obj1
 * @param obj1
 * @param obj2
 * @returns obj3 a new object based on obj1 and obj2
 */
function mergeOptions(obj1, obj2){
  var obj3 = {};
  Object.getOwnPropertyNames(obj1).forEach(function(attrname) {
    obj3[attrname] = obj1[attrname];
  });
  Object.getOwnPropertyNames(obj2).forEach(function(attrname) {
    obj3[attrname] = obj2[attrname];
  });
  return obj3;
}

// [Event EmitterObjects]
// Local REST API Client Object:
// REST client functions will be called more often than
//  the client object will be created. Use bound functions
//  for better performance.
// Contains both event emitting funcs and callback calling funcs:
//  Preference is for emitted events
//  Performance means not creating new objects per call
//  Calls with static event names will conflict
//  User-specified event names are necessary
//  Simple cases are now complicated by event name bookkeeping.
//  Single-callback functions are provided as convenience.
//  Run-time determination is possible, but more inspection means
//   less performance, so they are kept separate.
//  Login and logout will never conflict, so this duplication and
//   user-specified event names are not necessary for them.
// Define the object template:
var ClientTemplate = {
    getBound_logIn: function(self) {
        return function(options) {
            // Get options, even if none given:
            var safeOpts = options || {};
            // Error if username xor password was passed in:
            if (safeOpts.username && !safeOpts.password) {
                self.emit('error', {message: "Client login options contained the username " +
                                             " but no password."});
                return;
            }
            if (!safeOpts.username && safeOpts.password) {
                self.emit('error', {message: "Client login options contained the password " +
                                             " but no username."});
                return;
            }
            // Get Username/password (with defaults), build body
            var username = safeOpts.username || "testlab";
            var password = safeOpts.password || "changeme";
            var data = "username="+username+"&password="+password;
            // Set local options:
            var localOptions = {
                    path          : safeOpts.path        || '/login',
                    contentLength : data.length,
                    contentType   : "application/x-www-form-urlencoded"
            };
            self.connectionOptions = {};
            if(safeOpts.host || safeOpts.port) {
              localOptions.host = safeOpts.host || '127.0.0.1';
              localOptions.port = safeOpts.port || 3001;
              // Save the host/port we logged in to for future calls.
              self.connectionOptions.host = localOptions.host;
              self.connectionOptions.port = localOptions.port;
            } else {
              // default to unix-domain socket since we are trying to connect to
              // the local REST server and shouldn't need to be authorized
              localOptions.socketPath = unixSockName;
              // Save the socketName we logged in to for future calls.
              self.connectionOptions.socketPath = localOptions.socketPath;
              // No need to explicitly login when using unix-domain sockets.
              process.nextTick(function() {
                self.loggedIn = true;
                self.emit('login');
              }); 
              return;
            }
            // Set Response callback:
            localOptions.callback = function(loginResponse) {
                var body = "";
                var checkBody = function() {
                    if (body.indexOf("login") != -1) {
                        self.emit('loginFailure', loginResponse, body);
                    } else {
			var setCookieHdr = loginResponse.headers['set-cookie'];
			if(setCookieHdr instanceof Array) {
			    setCookieHdr = setCookieHdr[0];
			}
                        self.sid = setCookieHdr.split('; ')[0];
                        self.loggedIn = true;
                        self.emit('login');
                    }
                };
                loginResponse.on('data', function(chunk) {body += chunk;});
                loginResponse.on('end', checkBody);
            };
            // Create the request:
            var req = getPostReq(localOptions, self.connectionOptions);
            // Set the error callback:
            req.on('error',
                   function(error) {self.emit('loginRequestFailure', error);}
            );
            // Log in:
            req.write(data);
            req.end();
        };
    },
    getBound_logOut: function(self) {
        return function(options) {
            // Get options, even if none given:
            var safeOpts = options || {};
            // Set local options:
            var localOptions = {
                    path   : safeOpts.path || '/logout',
                    cookie : self.sid
            };
            // Set Response callback:
            localOptions.callback = function(logoutResponse) {
                    self.loggedIn = false;
                    self.emit('logout');
            };
            // Create the request:
            var req = getGetReq(localOptions, self.connectionOptions);
            // Set the error callback:
            req.on('error',
                   function(error) {self.emit('logoutRequestFailure', error);}
            );
            // Log out:
            req.end();
        };
    },
    getBound_getJSON: function(self, installErrorProxy) {
        return function(optionsOrPathArg, callbackArg) {
            var options = parseOptions(arguments, ['path'], ['callback']);
            // Set local options:
            var localOptions = {
                    path       : self.apiPrefix + options.path,
                    cookie     : self.sid,
                    callback   : options.callback   || printResponse
            };
            // Create the request:
            var req = getGetReq(localOptions, self.connectionOptions);
            // Set the error callback:
            installErrorProxy(req);
            // Send the Get request:
            req.end();
            return req;
        };
    },
    getBound_putJSON: function(self, installErrorProxy) {
        return function(optionsOrPathArg, callbackArg) {
            var options = parseOptions(arguments,
                                       ['path','body'],
                                       ['callback']);
            // Convert JSON to string:
            var jsonString = toJsonString(options['body']);
            // Set local options:
            var localOptions = {
                    path          : self.apiPrefix + options.path,
                    contentLength : jsonString.length,
                    contentType   : "application/json",
                    cookie        : self.sid,
                    callback      : options.callback    || printResponse
            };
            // Create the request:
            var req = getPutReq(localOptions, self.connectionOptions);
            // Set the error callback:
            installErrorProxy(req);
            // Send the put request:
            req.write(jsonString);
            req.end();
            return req;
        };
    },
    getBound_postJSON: function(self, installErrorProxy) {
        return function(optionsOrPathArg, callbackArg) {
            var options = parseOptions(arguments,
                                       ['path','body'],
                                       ['callback']);
            // Convert JSON to string:
            var jsonString = toJsonString(options['body']);
            // Set local options:
            var localOptions = {
                    path          : self.apiPrefix + options.path,
                    contentLength : jsonString.length,
                    contentType   : "application/json",
                    cookie        : self.sid,
                    callback      : options.callback     || printResponse
            };
            // Create the request:
            var req = getPostReq(localOptions, self.connectionOptions);
            // Set the error callback:
            installErrorProxy(req);
            // Send the post request:
            req.write(jsonString);
            req.end();
            return req;
        };
    },
    getBound_deleteJSON: function(self, installErrorProxy) {
        return function(optionsOrPathArg, callbackArg) {
            var options = parseOptions(arguments, ['path'], ['callback']);
            // Set local options:
            var localOptions = {
                    path       : self.apiPrefix + options.path,
                    cookie     : self.sid,
                    callback   : options.callback   || printResponse
            };
            // Create the request:
            var req = getDeleteReq(localOptions, self.connectionOptions);
            // Set the error callback:
            installErrorProxy(req);
            // Send the delete request:
            req.end();
            return req;
        };
    },
    getBound_installErrorProxy: function(self) {
      return function(req) {
        req.on('error', function(error) {
          if(req.listeners('error').length > 1) {
            // The user installed their own listener on this request.
            return;
          } else {
            // We should proxy the error; either the user's Client.on('error')
            // handler gets called or it'll be an uncaught exception.
            self.emit('error', error);
          }
        });
      }
    }
};
var Client = function() {
    // Call prototype constructor/init:
    events.EventEmitter.call(this);
    // Set default parameters:
    this.loggedIn = false;
    this.apiPrefix = '/lrs/api/v1.0';

    // Get a function to proxy errors on any requests.
    var installErrorProxy = ClientTemplate.getBound_installErrorProxy(this);

    // Bind functions to the instantiated object:
    this.logIn      = ClientTemplate.getBound_logIn(this, installErrorProxy);
    this.logOut     = ClientTemplate.getBound_logOut(this, installErrorProxy);
    this.getJSON    = ClientTemplate.getBound_getJSON(this, installErrorProxy);
    this.putJSON    = ClientTemplate.getBound_putJSON(this, installErrorProxy);
    this.postJSON   = ClientTemplate.getBound_postJSON(this, installErrorProxy);
    this.deleteJSON = ClientTemplate.getBound_deleteJSON(this,
                                                         installErrorProxy);
};
util.inherits(Client, events.EventEmitter);

// [Base REST Functions]
// Post data to the local REST API:
function getPostReq(options, connectionOptions) {
    // Test for required options:
    testRequiredOptions(options,
                        ["path","contentLength","contentType"]);
    // Create the HTTP request options:
    var requestOptions = {
        path    : options.path,
        method  : "POST",
        agent   : false,
        headers : {
            Accept           : "*/*",
            "Content-Length" : options.contentLength,
            "Content-Type"   : options.contentType
        }
    };
    requestOptions = mergeOptions(requestOptions, connectionOptions);
    // Add cookies if provided:
    if (options.cookie) {requestOptions.headers.Cookie = options.cookie;}
    // create standard HTTP request, and return it:
    var req = http.request(requestOptions, options.callback);
    req.removeHeader("Host");
    req.setHeader("Host", options.host + ":" + options.port);
    return req;
}
// Get data from the local REST API:
function getGetReq(options, connectionOptions) {
    // Test for required options:
    testRequiredOptions(options, ["path"]);
    // Create the HTTP request options:
    var requestOptions = {
        path    : options.path,
        method  : "GET",
        agent   : false,
        headers : {
            Accept : "*/*"
        }
    };
    requestOptions = mergeOptions(requestOptions, connectionOptions);
    // Add cookies if provided:
    if (options.cookie) {requestOptions.headers.Cookie = options.cookie;}
    // create standard HTTP request, and return it:
    var req = http.request(requestOptions, options.callback);
    req.removeHeader("Host");
    req.setHeader("Host", options.host + ":" + options.port);
    return req;
}
// Delete data from the local REST API:
function getDeleteReq(options, connectionOptions) {
    // Test for required options:
    testRequiredOptions(options, ["path"]);
    // Create the HTTP request options:
    var requestOptions = {
        path    : options.path,
        method  : "DELETE",
        headers : {
            Accept : "*/*"
        }
    };
    requestOptions = mergeOptions(requestOptions, connectionOptions);
    // Add cookies if provided:
    if (options.cookie) {requestOptions.headers.Cookie = options.cookie;}
    // create standard HTTP request, and return it:
    var req = http.request(requestOptions, options.callback);
    req.removeHeader("Host");
    req.setHeader("Host", options.host + ":" + options.port);
    return req;
}
// Put data in the local REST API:
function getPutReq(options, connectionOptions) {
    // Test for required options:
    testRequiredOptions(options,
                        ["path","contentLength","contentType"]);
    // Create the HTTP request options:
    var requestOptions = {
        path    : options.path,
        method  : "PUT",
        headers : {
            Accept           : "*/*",
            "Content-Length" : options.contentLength,
            "Content-Type"   : options.contentType
        }
    };
    requestOptions = mergeOptions(requestOptions, connectionOptions);
    // Add cookies if provided:
    if (options.cookie) {requestOptions.headers.Cookie = options.cookie;}
    // create standard HTTP request, and return it:
    var req = http.request(requestOptions, options.callback);
    req.removeHeader("Host");
    req.setHeader("Host", options.host + ":" + options.port);
    return req;
}

// [Utility Functions]
// Default Response Function:
function printResponse(response)
{
    var body = '';
    response.on('end', function() {
      console.log('Management REST xaction STATUS: ' + response.statusCode);
      if (body !== '') {
        console.log('Management REST xaction BODY: ' + body);
      }
    });
    response.on('data', function(chunk) { body += chunk; });
}
// Test for required options:
function testRequiredOptions(options, requiredOptions) {
    for (var i = 0; i < requiredOptions.length; i++) {
        var opt = requiredOptions[i];
        if (!options[opt]) {throw missingArgError(opt);}
    }
}

// Helper for an API method where the arguments could be in either a simple
// form, or an object specifier form.  Return an object specifier.
// e.g. instead of:
//    function({path: '/path', 'body': { x: 1 } }, cb)     also allow
//    function('/path', { x: 1 }, cb);
//
// args is the arguments from the API function that the user called.
//
// The first required arg must be a string.
//
// requiredArgs is an array of the required arguments in the order that they
// will appear in the short form; e.g. if requiredArgs = ['path', 'body'] then
// there must be at least 2 arguments; the first one will be the path, the
// second will be the body.
//
// optionalArgs is an array of optional arguments that may appear after the
// requiredArgs.  If there are more args than requiredArgs, then every
// remaining arg is matched to an optionalArg in order.
function parseOptions(args, requiredArgs, optionalArgs) {
  if (args.length === 0) {
    if (requiredArgs.length === 0) {
      return {};
    } else {
      throw new Error('More arguments required (' + requiredArgs + ')');
    }
  }
  var toReturn = {};
  if (isString(args[0])) {
    // In the 'simple' case.
    if (args.length < requiredArgs.length) {
      throw new Error('More arguments required (' + requiredArgs + ')');
    }
    for(var i = 0; i < requiredArgs.length; ++i) {
      toReturn[requiredArgs[i]] = args[i];
    }

    // Every arg past requiredArgs.length is an optional arg.
    var availOptionalArgs = Math.min(args.length - requiredArgs.length,
                                     optionalArgs.length);
    for(var i = 0; i < availOptionalArgs; ++i) {
      toReturn[optionalArgs[i]] = args[requiredArgs.length + i];
    }
  } else {
    // In the object specifier case
    testRequiredOptions(args[0], requiredArgs);
    for(var key in args[0]) {
      toReturn[key] = args[0][key];
    }

    // Every arg past arg[0] (the object specifier) is an optional arg.
    var availOptionalArgs = Math.min(args.length - 1, optionalArgs.length);
    for(var i = 0; i < availOptionalArgs; ++i) {
      toReturn[optionalArgs[i]] = args[1 + i];
    }
  }
  return toReturn;
}
// From underscore; also considers "new String('foo')" to be a string.
function isString(obj) {
  return Object.prototype.toString.call(obj) === '[object String]';
}
// Returns obj as a JSON string, or throws a helpful error
// If arg is already a string, it is assumed to be a JSON string (the REST
// server will return an error if the string is invalid).
function toJsonString(arg) {
  if (isString(arg)) {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch (err) {
    var message = 'Argument could not be converted to JSON';
    if (err.message) {
      message += ' (' + err.message + ')';
    }
    throw new Error(message);
  }
}
// Get argument error object:
function missingArgError(name) {
    return new Error("Missing required argument: " + name);
}

// [Exports]
exports.Client       = Client;
exports.printResponse = printResponse;
