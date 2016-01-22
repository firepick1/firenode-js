var child_process = require('child_process');
var path = require("path");
var FireKue = require("../www/js/shared/FireKue");
var Logger = require("../www/js/shared/Logger");

(function(exports) {
    var verboseLogger = new Logger({
        logLevel: "debug"
    });

    ///////////////////////// private instance variables

    ////////////////// constructor
    function FireKueREST(images, firesight, mesh_rest, options) {
        var that = this;
        options = options || {};

        if ((that.images = images) == null) throw new Error("images is required");
        if ((that.firesight = firesight) == null) throw new Error("firesight is required");
        if ((that.firestep = images.firestep) == null) throw new Error("firestep is required");
        if ((that.camera = images.camera) == null) throw new Error("camera is required");;
        if ((that.mesh_rest = mesh_rest) == null) throw new Error("mesh_rest is required");;
        that.fireKue = new FireKue();
        that.fireKue.add({
            type: "test",
            state: "active",
            data: {
                color: "yellow"
            }
        });
        that.fireKue.add({
            type: "test",
            data: {
                color: "blue"
            }
        });
        that.fireKue.add({
            type: "test",
            state: "complete",
            data: {
                color: "green"
            },
            result: "happiness",
        });
        that.fireKue.add({
            type: "test",
            state: "failed",
            data: {
                color: "red"
            }
        });
        that.model = {
            rest: "FireKueREST",
        };
        if (options.verbose) {
            that.verbose = options.verbose;
        }

        return that;
    }

    var httpInclude = [
        "/camera",
        "/images",
        "/firestep",
        "/firesight",
        "/mesh",
        "/measure",
    ];
    var httpExclude = [
        "/model",
        "/image.jpg",
        "/images/location",
        "/out.jpg",
    ]

    FireKueREST.prototype.observe_http = function(req) {
        var that = this;
        var url = req.url;
        var observe = false;
        for (var i=httpInclude.length; i-->0; ){
            if (req.url.startsWith(httpInclude[i])) {
                observe = true;
            }
        }
        for (var i=httpExclude.length; observe && i-->0; ){
            if (req.path.endsWith(httpExclude[i])) {
                observe = false;
            }
        }
        if (!observe) {
            return;
        }
        console.log("FireKue\t:", req.method, url);
        var job = {
            type: "REST",
            data: {
                url: req.url,
                method: req.method,
            }
        };
        if (req.method === "POST") {
            job.data.body = req.body;
        }
        that.fireKue.add(job);
    }
    FireKueREST.prototype.isAvailable = function() {
        var that = this;
        return that.model.rest === "FireKueREST";
    }
    FireKueREST.prototype.job_GET = function(tokens) {
        var that = this;
        if (tokens.length !== 1) {
            return new Error("expected job id");
        }
        var id = tokens[0];
        var job = that.fireKue.get(Number(id));
        if (job == null) {
            return new Error("job " + id + " not found");
        }
        return job;
    }
    FireKueREST.prototype.job_POST = function(job) {
        var that = this;
        return that.fireKue.add(job);
    }
    FireKueREST.prototype.jobs_GET = function(tokens) {
        var that = this;
        if (tokens.length < 1) {
            return new Error("Invalid jobs url (too short)");
        }
        var options = {};
        var order = {
            asc: "asc",
            desc: "desc"
        };
        var state = {
            active: "active",
            inactive: "inactive",
            complete: "complete",
            failed: "failed",
        };
        var end = tokens.length - 1;
        options.order = order[tokens[end]];
        if (options.order) {
            end--;
        }
        var fromto = tokens[end].split("..");
        if (fromto.length !== 2) {
            return new Error('Expected jobs url to end with "/:from..:to/:order?"');
        }
        options.from = fromto[0].length ? Number(fromto[0]) : null;
        options.to = fromto[1].length ? Number(fromto[1]) : null;
        end--;
        if (end >= 0) {
            options.state = state[tokens[end]];
            if (options.state == null) {
                return new Error("Could not parse jobs url with unknown state:" + tokens[end]);
            }
            end--;
        }
        if (end >= 0) {
            options.type = tokens[end];
            end--;
        }
        if (end != -1) {
            return new Error("Unknown token in jobs url:", tokens[end]);
        }
        //that.verbose && verboseLogger.debug("jobs options:", options);
        return that.fireKue.findJobs(options);
    }

    module.exports = exports.FireKueREST = FireKueREST;
})(typeof exports === "object" ? exports : (exports = {}));