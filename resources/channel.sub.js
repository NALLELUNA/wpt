(function() {
    function randInt(bits) {
        if (bits < 1 || bits > 53) {
            throw new TypeError();
        } else {
            if (bits >= 1 && bits <= 30) {
                return 0 | ((1 << bits) * Math.random());
            } else {
                var high = (0 | ((1 << (bits - 30)) * Math.random())) * (1 << 30);
                var low = 0 | ((1 << 30) * Math.random());
                return  high + low;
            }
        }
    }


    function toHex(x, length) {
        var rv = x.toString(16);
        while (rv.length < length) {
            rv = "0" + rv;
        }
        return rv;
    }

    function createUuid() {
        return [toHex(randInt(32), 8),
         toHex(randInt(16), 4),
         toHex(0x4000 | randInt(12), 4),
         toHex(0x8000 | randInt(14), 4),
         toHex(randInt(48), 12)].join("-");
    }


    // TODO: should be a way to clean up unused sockets
    class SocketCache {
        constructor() {
            this.readSockets = new Map();
            this.writeSockets = new Map();
        };

        async getOrCreate(type, uuid, onmessage=null) {
            function createSocket() {
                let protocol = self.isSecureContext ? "wss" : "ws";
                let port = self.isSecureContext? "{{ports[wss][0]}}" : "{{ports[ws][0]}}";
                let url = `${protocol}://{{host}}:${port}/msg_channel?uuid=${uuid}&direction=${type}`;
                let socket = new WebSocket(url);
                if (onmessage !== null) {
                    socket.onmessage = onmessage;
                };
                return new Promise(resolve => socket.addEventListener("open", () => resolve(socket)));
            }

            let socket;
            if (type === "read") {
                if (this.readSockets.has(uuid)) {
                    throw new Error("Can't create multiple read sockets with same UUID");
                }
                socket = await createSocket();
                socket.addEventListener("close", () => this.readSockets.delete(uuid));
                this.readSockets.set(uuid, socket);
            } else if (type === "write") {
                let count;
                if (onmessage !== null) {
                    throw new Error("Can't set message handler for write sockets");
                }
                if (this.writeSockets.has(uuid)) {
                    [socket, count] = this.writeSockets.get(uuid);
                } else {
                    socket = await createSocket();
                    count = 0;
                }
                count += 1;
                socket.addEventListener("close", () => this.writeSockets.delete(uuid));
                this.writeSockets.set(uuid, [socket, count]);
            } else {
                throw new Error(`Unknown type ${type}`);
            }
            return socket;
        };

        async close(type, uuid) {
            let target = type === "read" ? this.readSockets : this.writeSockets;
            const data = target.get(uuid);
            if (!data) {
                return;
            }
            let count, socket;
            if (type == "read") {
                socket = data;
                count = 0;
            } else if (type === "write") {
                [socket, count] = data;
                count -= 1;
                if (count > 0) {
                    target.set(uuid, [socket, count]);
                }
            };
            if (count <= 0 && socket) {
                target.delete(uuid);
                socket.close(1000);
                await new Promise(resolve => socket.onclose = () => resolve());
            }
        };

        async closeAll() {
            let sockets = [];
            this.readSockets.forEach(value => sockets.push(value));
            this.writeSockets.forEach(value => sockets.push(value[0]));
            let closePromises = sockets.map(socket => new Promise(resolve => socket.onclose = () => resolve()));
            sockets.forEach(socket => socket.close(1000));
            this.readSockets.clear();
            this.writeSockets.clear();
            await Promise.all(closePromises);
        }
    }

    const socketCache = new SocketCache();

    class Channel {
        type = null;

        constructor(uuid) {
            this.uuid = uuid;
            this.socket = null;
        }

        hasConnection() {
            return this.socket !== null && this.socket.readyState <= WebSocket.OPEN;
        }

        async connect(onmessage) {
            if (this.hasConnection()) {
                return;
            }
            this.socket = await socketCache.getOrCreate(this.type, this.uuid, onmessage);
        }

        async close() {
            this.socket = null;
            await socketCache.close(this.type, this.uuid);
        }
    }

    class SendChannel extends Channel {
        type = "write";

        async connect() {
            return super.connect(null);
        }

        async _send(cmd, body=null) {
            if (!this.hasConnection()) {
                await this.connect();
            }
            this.socket.send(JSON.stringify([cmd, body]));
        }

        async send(msg) {
            this._send("message", msg);
        }

        async pause() {
            console.log("pause");
            this._send("pause");
        }

        async delete() {
            this._send("delete");
        }
    };
    self.SendChannel = SendChannel;

    const recvChannelsCreated = new Set();

    class RecvChannel extends Channel {
        type = "read";

        constructor(uuid) {
            if (recvChannelsCreated.has(uuid)) {
                throw new Error(`Already created RecvChannel with id ${uuid}`);
            }
            super(uuid);
            this.eventListeners = new Set();
        };

        async connect() {
            if (this.hasConnection()) {
                return;
            }
            await super.connect(event => this.readMessage(event.data));
        }

        readMessage(data) {
            console.log("readMessage", data, this.eventListeners);
            let msg = JSON.parse(data);
            this.eventListeners.forEach(fn => fn(msg));
        };

        addEventListener(fn) {
            this.eventListeners.add(fn);
        };

        removeEventListener(fn) {
            this.eventListeners.delete(fn);
        };

        next() {
            return new Promise(resolve => {
                let fn = (msg) => {
                    this.removeEventListener(fn);
                    resolve(msg);
                };
                this.addEventListener(fn);
            });
        }
    }

    self.channel = function() {
        let uuid = createUuid();
        let recvChannel = new RecvChannel(uuid);
        let sendChannel = new SendChannel(uuid);
        return [recvChannel, sendChannel];
    };

    self.window_channel = function() {
        let uuid = new URLSearchParams(location.search).get("uuid");
        if (!uuid) {
            throw new Error("URL must have a uuid parameter to use as a RemoteWindow");
        }
        return new RemoteWindowCommandRecvChannel(new RecvChannel(uuid));
    };

    self.start_window_channel = async function() {
        let channel = self.window_channel();
        await channel.connect();
        return channel;
    };

    self.closeAllChannelSockets = async function() {
        await socketCache.closeAll();
        await new Promise(resolve => setTimeout(resolve, 0));
    };

    class RemoteWindowCommandRecvChannel {
        constructor(recvChannel) {
            this.channel = recvChannel;
            this.uuid = recvChannel.uuid;
            this.channel.addEventListener(msg => this.handleMessage(msg));
            this.messageHandlers = new Set();
        };

        async connect() {
            await this.channel.connect();
        }

        async close() {
            await this.channel.close();
        }

        async handleMessage(msg) {
            const {id, command, params, respChannel} = msg;
            let result = {};
            let resp = {id, result};
            if (command === "executeScript") {
                const fn = deserialize(params.fn);
                const args = params.args.map(x => {
                    return deserialize(x);
                });
                try {
                    let resultValue = await new Promise(resolve => {
                        Promise.resolve(fn(...args)).then(resolve);
                    });
                    result.result = serialize(resultValue);
                } catch(e) {
                    let exception = serialize(e);
                    const getAsInt = (obj, prop) =>  {
                        let value = parseInt(prop in obj ? obj[prop] : 0);
                        return Number.isNaN(value) ? 0 : value;
                    };
                    result.exceptionDetails = {
                        text: "" + e.toString(),
                        lineNumber: getAsInt(e, "lineNumber"),
                        columnNumber: getAsInt(e, "columnNumber"),
                        exception
                    };
                }
            } else if (command === "postMessage") {
                this.messageHandlers.forEach(fn => fn(deserialize(params.msg)));
            }
            if (respChannel) {
                let chan = deserialize(respChannel);
                await chan.connect();
                await chan.send(resp);
            }
        }

        addMessageHandler(fn) {
            this.messageHandlers.add(fn);
        }

        removeMessageHandler(fn) {
            this.messageHandlers.delete(fn);
        }

        nextMessage() {
            return new Promise(resolve => {
                let fn = (msg) => {
                    this.removeEventListener(fn);
                    resolve(msg);
                };
                this.addEventListener(fn);
            });
        }

    }

    class RemoteWindowResponseRecvChannel {
        constructor(recvChannel) {
            this.channel = recvChannel;
            this.channel.addEventListener(msg => this.handleMessage(msg));
            this.responseHandlers = new Map();
        }

        setResponseHandler(commandId, fn) {
            this.responseHandlers.set(commandId, fn);
        }

        handleMessage(msg) {
            let {id, result} = msg;
            let handler = this.responseHandlers.get(id);
            if (handler) {
                this.responseHandlers.delete(id);
                handler(result);
            }
        }

        close() {
            return this.channel.close();
        }
    }

    class RemoteWindow {
        constructor(dest) {
            if (!dest) {
                dest = createUuid();
            }
            if (typeof dest == "string") {
                this.uuid = dest;
                this.sendChannel = new SendChannel(dest);
            } else {
                this.sendChannel = dest;
                this.uuid = dest.uuid;
            }
            this.recvChannel = null;
            this.respChannel = null;
            this.connected = false;
            this.commandId = 0;
        }

        async connect() {
            if (this.connected) {
                return;
            }
            let [recvChannel, respChannel] = self.channel();
            await Promise.all([this.sendChannel.connect(), recvChannel.connect()]);
            this.recvChannel = new RemoteWindowResponseRecvChannel(recvChannel);
            this.respChannel = respChannel;
            this.connected = true;
        }

        async sendMessage(command, params, hasResp=true) {
            if (!this.connected) {
                await this.connect();
            }
            let msg = {id: this.commandId++, command, params};
            if (hasResp) {
                msg.respChannel = serialize(this.respChannel);
            }
            let response;
            if (hasResp) {
                response = new Promise(resolve =>
                    this.recvChannel.setResponseHandler(msg.id, resolve));
            } else {
                response = Promise.resolve(null);
            }
            this.sendChannel.send(msg);
            return await response;
        }

        async executeScript(fn, ...args) {
            let result = await this.sendMessage("executeScript", {fn: serialize(fn), args: args.map(x => serialize(x))}, true);
            if (result.exceptionDetails) {
                throw deserialize(result.exceptionDetails.exception);
            }
            return deserialize(result.result);
        }


        async postMessage(msg) {
            await this.sendMessage("postMessage", {msg: serialize(msg)}, false);
        }

        pause() {
            // This causes any readers to disconnect until they are explictly reconnected
            return this.sendChannel.pause();
        }

        close() {
            let closers = [this.sendChannel.close()];
            if (this.recvChannel !== null) {
                closers.push(this.recvChannel.close());
            }
            if (this.respChannel !== null) {
                closers.push(this.respChannel.close());
            }
            return Promise.all(closers);
        }
    }

    self.RemoteWindow = RemoteWindow;

    function typeName(obj) {
        let type = typeof obj;
        // The handling of cross-global objects here is broken
        if (type === "undefined" ||
            type === "string" ||
            type === "boolean" ||
            type === "number" ||
            type === "bigint" ||
            type === "symbol" ||
            type === "function") {
            return type;
        }

        if (obj === null) {
            return "null";
        }
        if (obj instanceof RemoteObject) {
            return "remoteobject";
        }
        if (obj instanceof SendChannel) {
            return "sendchannel";
        }
        if (obj instanceof RecvChannel) {
            return "recvchannel";
        }
        if (obj instanceof Error) {
            return "error";
        }
        if (Array.isArray(obj)) {
            return "array";
        }
        let constructor = obj.constructor && obj.constructor.name;
        if (constructor === "RegExp" ||
            constructor === "Date" ||
            constructor === "Map" ||
            constructor === "Set" ||
            constructor == "WeakMap" ||
            constructor == "WeakSet") {
            return constructor.toLowerCase();
        }
        // The handling of cross-global objects here is broken
        if (typeof window == "object" && window === self) {
            if (obj instanceof Element) {
                return "element";
            }
            if (obj instanceof Document) {
                return "document";
            }
            if (obj instanceof Node) {
                return "node";
            }
            if (obj instanceof Window) {
                return "window";
            }
        }
        if (Promise.resolve(obj) === obj) {
            return "promise";
        }
        return "object";
    }

    let remoteObjectsById = new Map();

    function remoteId(obj) {
        let rv;
        rv = createUuid();
        remoteObjectsById.set(rv, obj);
        return rv;
    }

    class RemoteObject {
        constructor(type, objectId) {
            this.type = type;
            this.objectId = objectId;
        }

        static from(obj) {
            let type = typeName(obj);
            let id = remoteId(obj);
            return new RemoteObject(type, id);
        }

        toLocal() {
            if (remoteObjectsById.has(this.objectId)) {
                return remoteObjectsById.get(this.objectId);
            }
            return null;
        }

        delete() {
            if (remoteObjectsById.has(this.objectId)) {
                remoteObjectsById.delete(this.objectId);
            }
        }
    }

    self.RemoteObject = RemoteObject;

    function serialize(obj) {
        const stack = [{item: obj}];
        let serialized = null;

        // Map from container object input to output value
        let objectsSeen = new Map();
        let lastObjectId = 0;

        while (stack.length > 0) {
            const {item, target, targetKey} = stack.shift();
            let type = typeName(item);
            let value;
            let objectId;
            let newTarget;

            if (objectsSeen.has(item)) {
                let outputValue = objectsSeen.get(item);
                if (!outputValue.hasOwnProperty("objectId")) {
                    outputValue.objectId = lastObjectId++;
                }
                objectId = outputValue.objectId;
            } else {
                switch (type) {
                case "undefined":
                case "null":
                    break;
                case "string":
                case "boolean":
                    value = item;
                    break;
                case "number":
                    if (item !== item) {
                        value = "NaN";
                    } else if (item === 0 && 1/item == Number.NEGATIVE_INFINITY) {
                        value = "-0";
                    } else if (item === Number.POSITIVE_INFINITY) {
                        value = "+Infinity";
                    } else if (item === Number.NEGATIVE_INFINITY) {
                        value = "-Infinity";
                    } else {
                        value = item;
                    }
                    break;
                case "bigint":
                case "function":
                    value = obj.toString();
                    break;
                case "remoteobject":
                    value = {
                        type: obj.type,
                        objectId: obj.objectId
                    };
                    break;
                case "sendchannel":
                    value = item.uuid;
                    break;
                case "regexp":
                    value = {
                        pattern:item.source,
                        flags: item.flags
                    };
                    break;
                case "date":
                    value = Date.prototype.toJSON.call(item);
                    break;
                case "error":
                    value = {
                        type: item.constructor.name,
                        message: item.message,
                        lineNumber: item.lineNumber,
                        columnNumber: item.columnNumber,
                        fileName: item.fileName,
                        stack: item.stack,
                    };
                    break;
                case "array":
                case "set":
                    value = [];
                    newTarget = {type: "array", value};
                    for (let child of item) {
                        stack.push({item: child, target: newTarget});
                    }
                    break;
                case "object":
                    value = {};
                    newTarget = {type: "object", value};
                    for (let [targetKey, child] of Object.entries(item)) {
                        stack.push({item: child, target: newTarget, targetKey});
                    }
                    break;
                case "map":
                    value = [];
                    newTarget = {type: "map", value};
                    for (let [targetKey, child] of item.entries()) {
                        stack.push({item: targetKey, target: newTarget, targetKey: "key"});
                        stack.push({item: child, target: newTarget, targetKey: "value"});
                    }
                    break;
                default:
                    throw new TypeError(`Can't serialize value of type ${type}; consider using RemoteObject.from() to wrap the object`);
                };
            }
            let result = {type};
            if (value !== undefined) {
                result.value = value;
            }
            if (objectId !== undefined) {
                result.objectId = objectId;
            } else {
                objectsSeen.set(item, result);
            }
            if (!target) {
                if (serialized !== null) {
                    throw new Error("Tried to create multiple output values");
                }
                serialized = result;
            } else {
                switch (target.type) {
                case "array":
                    target.value.push(result);
                    break;
                case "object":
                    target.value[targetKey] = result;
                    break;
                case "map":
                    if (targetKey === "key") {
                        target.value.push([]);
                    }
                    target.value[target.value.length - 1].push(result);
                    break;
                default:
                    throw new Error(`Unknown target type ${target.type}`);
                }
            }
        }
        return serialized;
    }

    function deserialize(obj) {
        let deserialized = null;
        let stack = [{item: obj, target: null}];
        let objectMap = new Map();

        while (stack.length > 0) {
            const {item, target, targetKey} = stack.shift();
            const {type, value, objectId} = item;
            let result;
            let newTarget;
            if (objectId !== undefined && value === undefined) {
                result = objectMap.get(objectId);
            } else {
                switch(type) {
                case "undefined":
                    result = undefined;
                    break;
                case "null":
                    result = null;
                    break;
                case "string":
                case "boolean":
                    result = value;
                    break;
                case "number":
                    if (typeof value === "string") {
                        switch(value) {
                        case "NaN":
                            result = NaN;
                            break;
                        case "-0":
                            result = -0;
                            break;
                        case "+Infinity":
                            result = Number.POSITIVE_INFINITY;
                            break;
                        case "-Infinity":
                            result = Number.NEGATIVE_INFINITY;
                            break;
                        default:
                            throw new Error(`Unexpected number value "${value}"`);
                        }
                    } else {
                        result = value;
                    }
                    break;
                case "bigint":
                    result = BigInt(value);
                    break;
                case "function":
                    result = new Function("...args", `return (${value}).apply(null, args)`);
                    break;
                case "remoteobject":
                    let remote = new RemoteObject(value.type, value.objectId);
                    let local = remote.toLocal();
                    if (local !== null) {
                        result = local;
                    } else {
                        result = remote;
                    }
                    break;
                case "sendchannel":
                    result = new SendChannel(value);
                    break;
                case "regexp":
                    result = new RegExp(value.pattern, value.flags);
                    break;
                case "date":
                    result = new Date(value);
                    break;
                case "error":
                    if (item.value.type in self &&
                        typeof self[item.value.type] === "function") {
                        result = new self[item.value.type](item.value.message);
                    } else {
                        result = new Error(item.value.message);
                    }
                    result.lineNumber = item.value.lineNumber;
                    result.columnNumber = item.value.columnNumber;
                    result.fileName = item.value.fileName;
                    result.stack = item.value.stack;
                    break;
                case "array":
                    result = [];
                    newTarget = {type: "array", value: result};
                    for (let child of value) {
                        stack.push({item: child, target: newTarget});
                    }
                    break;
                case "set":
                    result = new Set();
                    newTarget = {type: "set", value: result};
                    for (let child of value) {
                        stack.push({item: child, target: newTarget});
                    }
                    break;
                case "object":
                    result = {};
                    newTarget = {type: "object", value: result};
                    for (let [targetKey, child] of Object.entries(value)) {
                        stack.push({item: child, target: newTarget, targetKey});
                    }
                    break;
                case "map":
                    result = new Map();
                    newTarget = {type: "map", value: result};
                    for (let [key, child] of value) {
                        stack.push({item: key, target: newTarget, targetKey: "key"});
                        stack.push({item: child, target: newTarget, targetKey: "value"});
                    }
                    break;
                default:
                    throw new TypeError(`Can't deserialize object of type ${type}`);
                }
                if (objectId !== undefined) {
                    objectMap.set(objectId, result);
                }
            }

            if (target === null) {
                if (deserialized !== null) {
                    throw new Error("Tried to create multiple output values");
                }
                deserialized = result;
            } else {
                switch(target.type) {
                case "array":
                    target.value.push(result);
                    break;
                case "set":
                    target.value.add(result);
                    break;
                case "object":
                    target.value[targetKey] = result;
                    break;
                case "map":
                    if (targetKey === "key") {
                        target.key = result;
                    } else {
                        target.value.set(target.key, result);
                    }
                    break;
                default:
                    throw new Error(`Unknown target type ${target.type}`);
                }
            }
        }
        return deserialized;
    }
})();
