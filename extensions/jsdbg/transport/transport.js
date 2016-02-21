"use strict";

// jsdbg-transport.js
// Handles communication between the client and the JsDbg server.

var JsDbgTransport = undefined;
Loader.OnLoad(function() {
    if (window.WebSocket === undefined) {
        alert("JsDbg requires a browser that supports WebSockets.  Please use Edge, Internet Explorer 11, or Chrome.")
        throw new Error("WebSockets are required.");
    }

    var currentWebSocket = null;
    var currentWebSocketCallbacks = {};
    var remainingAllowableWebSocketRequests = 30; // Throttle the WebSocket requests to avoid overwhelming the connection.
    var pendingWebSocketMessages = []; // WebSocket requests that have not yet been sent due to throttling.

    // Certain types of requests are cacheable -- this maintains that cache.
    var responseCache = {};
    var transientCache = {};

    // If we make a cacheable request and there are already outstanding requests for that resource,
    // piggyback onto the existing request.  This maintains a list of piggybacked requests.
    var pendingCachedRequests = {};

    // A counter of the total number of requests made to the server.
    var requestCounter = 0;

    // Support for showing/hiding the progress indicator.
    var pendingAsynchronousRequests = 0;

    // Out-of-band message listeners.
    var outOfBandMessageListeners = [];

    function requestStarted() {
        ++requestCounter;
        ++pendingAsynchronousRequests;
        if (pendingAsynchronousRequests == 1) {
            // If we get blocked waiting for something, we'll be notified.
            JsDbgLoadingIndicator.Show();
        }
    }

    function requestEnded() {
        --pendingAsynchronousRequests;
        if (pendingAsynchronousRequests == 0) {
            JsDbgLoadingIndicator.Hide();
        }
    }

    function handleWebSocketReply(webSocketMessage) {
        var result = null;
        try {
            var parts = webSocketMessage.data.split(";", 3);
            if (parts.length != 3) {
                // The format wasn't what we expected, so treat it as an out-of-band message.
                outOfBandMessageListeners.forEach(function (f) { f(webSocketMessage.data); })
                return;
            }

            var responseId = parts[0];
            if (parts[1] != "200") {
                throw "JsDbg server failed with response (" + webSocketMessage.data + ")";
            }
            result = parts[2];
        } catch (error) {
            result = JSON.stringify({ error: error });
        }

        if (!(responseId in currentWebSocketCallbacks)) {
            throw "No registered callback for message id " + responseId;
        } else {
            // Fire the callback and remove it from the registry.
            currentWebSocketCallbacks[responseId].callback(result);
            delete currentWebSocketCallbacks[responseId];
            ++remainingAllowableWebSocketRequests;

            if (pendingWebSocketMessages.length > 0) {
                pendingWebSocketMessages[0]();
                pendingWebSocketMessages = pendingWebSocketMessages.slice(1);
            }
        }
    }

    function sendWebSocketMessage(requestId, messageToSend, callback) {
        var retryWebSocketRequest = function retryWebSocketRequest() { sendWebSocketMessage(requestId, messageToSend, callback); }
        if (currentWebSocket == null || (currentWebSocket.readyState > WebSocket.OPEN)) {
            currentWebSocket = new WebSocket("ws://" + window.location.host);
            currentWebSocket.addEventListener("message", handleWebSocketReply);

            currentWebSocket.addEventListener("close", function jsdbgWebSocketCloseHandler() {
                currentWebSocket = null;
                console.log("JsDbg web socket was closed...retrying in-flight requests.");

                // Retry the in-flight messages.
                var oldCallbacks = currentWebSocketCallbacks;
                currentWebSocketCallbacks = {};
                for (var key in oldCallbacks) {
                    var value = oldCallbacks[key];
                    sendWebSocketMessage(key, value.messageToSend, value.callback);
                }
            })
        }

        if (currentWebSocket.readyState < WebSocket.OPEN) {
            currentWebSocket.addEventListener("open", retryWebSocketRequest);
        } else if (currentWebSocket.readyState == WebSocket.OPEN) {
            if (remainingAllowableWebSocketRequests > 0) {
                --remainingAllowableWebSocketRequests;
                currentWebSocketCallbacks[requestId.toString()] = {
                    callback: callback,
                    messageToSend: messageToSend
                };
                currentWebSocket.send(requestId + ";" + messageToSend);
            } else {
                pendingWebSocketMessages.push(retryWebSocketRequest);
            }
        }
    }

    function jsonRequest(url, originalCallback, cacheType, method, data) {
        var callback = function(result) {
            try {
                originalCallback(result)
            } catch (error) {

            }
        };

        if (cacheType == JsDbgTransport.CacheType.Cached && url in responseCache) {
            callback(responseCache[url]);
            return;
        } else if (cacheType == JsDbgTransport.CacheType.TransientCache && url in transientCache) {
            callback(transientCache[url]);
            return;
        } else if (cacheType != JsDbgTransport.CacheType.Uncached) {
            if (url in pendingCachedRequests) {
                pendingCachedRequests[url].push(callback);
                return;
            } else {
                pendingCachedRequests[url] = [];
            }
        }

        requestStarted();

        function handleJsonResponse(jsonText) {
            try {
                var result = JSON.parse(jsonText);
            } catch (exception) {
                result = {
                    error: "Failed to parse JSON reponse: " + jsonText
                };
            }
            var otherCallbacks = [];
            if (cacheType != JsDbgTransport.CacheType.Uncached) {
                otherCallbacks = pendingCachedRequests[url];
                delete pendingCachedRequests[url];

                if (cacheType == JsDbgTransport.CacheType.Cached) {
                    responseCache[url] = result;
                } else if (cacheType == JsDbgTransport.CacheType.TransientCache) {
                    transientCache[url] = result;
                }
            }
            callback(result);
            otherCallbacks.forEach(function fireBatchedJsDbgCallback(f) { f(result); });
            requestEnded();
        }

        if (!method && !data) {
            // Use WebSockets if the request is async, the method is unspecified, and there's no data payload.
            sendWebSocketMessage(requestCounter, url, handleJsonResponse);
        } else {
            // Use XHR.
            if (!method) {
                method = "GET";
            }

            var xhr = new XMLHttpRequest();
            xhr.open(method, url, true);
            xhr.onreadystatechange = function() {
                if (xhr.readyState == 4 && xhr.status == 200) {
                    handleJsonResponse(xhr.responseText);
                }
            };
            xhr.send(data);
        }
    }

    JsDbgTransport = {
        CacheType: {
            Uncached:         0, // The resource is not cached.
            Cached:           1, // The resource is cached until the page is refreshed.
            TransientCache:   2, // The resource is cached until the cache is invalidated.
        },

        JsonRequest: jsonRequest,
        InvalidateCache: function() {
            transientCache = {};
        },
        OnOutOfBandMessage: function (listener) {
            outOfBandMessageListeners.push(listener);
        },
        GetNumberOfRequests: function() {
            return requestCounter;
        }
    }
});