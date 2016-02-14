const should = require("should");
const JsonUtil = require("./JsonUtil");
const Logger = require("./Logger");

// JSON messages synchronize base and clone.
// Messages are created by createSyncRequest()
// and returned by sync():
//   createSyncRequest() => message
//   sync(message) => newMessage
//
// ATTRIBUTES
// ----------   
// op:      message operation
// newRev:  model snapshot revision
// syncRev: cloned base model revision 
// model:   full synchronization data
// diff:    differential synchronization data 
// text:    message text
//
// STATES
// ------
// S0   Uninitialized
// SB   Base
// SBD  Base (with changes)
// SC   Synchronized clone
// SCX  Synchronized clone (stale)
// SCD  Synchronized clone (with changes)
// SCDX Synchronized clone (stale with changes)
//
// OP    newRev syncRev model diff DESCRIPTION
// ------------------------------------------------------------
// CLONE                           clone synchronization request
// RETRY                           retry later
// SYNC  RRR            MMM        synchronize clone with model MMM and syncRev RRR
// UPDB         SSS                request clone update
// UPDB         SSS           DDD  request clone update and send clone changes DDD to base
// UPDC  RRR    SSS           DDD  update clone with new syncRev RRR and base changes DDD since SSS 
// STALE RRR            MMM        synchronize stale clone with model MMM and syncRev RRR
// ERR                             sadness and disaster
// NOP                             no action required 
// OK           SSS                no action required (clone synchronized response)

(function(exports) {
    var verboseLogger = new Logger({
        logLevel: "debug"
    });

    function Synchronizer(model, options) {
        var that = this;
        options = options || {};

        that.model = model;
        that.decorate = options.decorate || function(model) {
            // add time-variant model decorations
        };
        that.baseRev = 0;
        if (options.verbose) {
            that.verbose = options.verbose;
        }

        return that;
    }

    Synchronizer.prototype.createSyncRequest = function() {
        var that = this;
        if (that.baseRev === 0) {
            return {
                op: Synchronizer.OP_CLONE,
            };
        } 
        var request = {
            op: Synchronizer.OP_UPDB,
            syncRev: that.syncRev,
        };
        var snapshot = JSON.stringify(that.model);
        if (snapshot !== that.baseSnapshot) {
            request.diff = JsonUtil.diffUpsert(that.model, that.baseModel);
        } 
        return request;
    }
    Synchronizer.prototype.rebase = function() {
        var that = this;
        var snapshot = JSON.stringify(that.model);
        if (snapshot != that.baseSnapshot) {
            that.decorate(that.model);
            that.baseSnapshot = JSON.stringify(that.model); // include decorations
            that.baseModel = JSON.parse(that.baseSnapshot);
            that.baseRev = Synchronizer.revision(that.baseSnapshot);
        }
        return that;
    }
    Synchronizer.prototype.createErrorResponse = function(request, text) {
        var that = this;
        that.verbose && verboseLogger.debug("Synchronizer.createErrorResponse() text:", text, 
            " request:", JSON.stringify(request));
        return  {
            op: Synchronizer.OP_ERR,
            text: text,
        }
    }
    Synchronizer.prototype.sync_clone = function(request) {
        var that = this;
        if (request.op !== Synchronizer.OP_CLONE) {
            return null;
        }
        if (that.baseRev === 0 || that.baseRev == null) {
            return {
                op: Synchronizer.OP_RETRY,
                text: Synchronizer.TEXT_RETRY,
            }
        }

        that.rebase();
        //that.verbose && verboseLogger.debug("Synchronizer.sync_clone() baseRev:", that.baseRev);
        return {
            op: Synchronizer.OP_SYNC,
            newRev: that.baseRev,
            text: Synchronizer.TEXT_SYNC,
            model: that.model,
        }
    }
    Synchronizer.prototype.sync_echo = function(request, op) {
        var that = this;
        if (request.op !== op) {
            return null;
        }
        return request;
    }
    Synchronizer.prototype.sync_sync = function(request) {
        var that = this;
        if (request.op !== Synchronizer.OP_SYNC) {
            return null;
        }

        if (!request.hasOwnProperty("model")) {
            return that.createErrorResponse(request, Synchronizer.ERR_MODEL);
        } else if (!request.hasOwnProperty("newRev")) {
            return that.createErrorResponse(request, Synchronizer.ERR_NEWREV);
        } 

        JsonUtil.applyJson(that.model, request.model); // preserve structure
        that.rebase();
        that.syncRev = request.newRev; 
        return {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_INITIALIZED,
            syncRev: that.syncRev,
        };
    }
    Synchronizer.prototype.sync_stale = function(request) {
        var that = this;
        if (request.op !== Synchronizer.OP_STALE) {
            return null;
        }

        if (!request.hasOwnProperty("model")) {
            return that.createErrorResponse(request, Synchronizer.ERR_MODEL);
        } else if (!request.hasOwnProperty("newRev")) {
            return that.createErrorResponse(request, Synchronizer.ERR_NEWREV);
        } 

        // TODO: Deal with stale model
        // for now, slam and hope for the best (ugly)
        JsonUtil.applyJson(that.model, request.model); // preserve structure
        that.rebase(); // TODO: new clone structures won't get sync'd

        that.syncRev = request.newRev; 
        return {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_INITIALIZED,
            syncRev: that.syncRev,
        };
    }
    Synchronizer.prototype.sync_updb = function(request) {
        var that = this;
        if (request.op !== Synchronizer.OP_UPDB) {
            return null;
        }
        if (!request.hasOwnProperty("syncRev")) {
            return that.createErrorResponse(request, Synchronizer.ERR_SYNCREV);
        }
        if (request.syncRev !== that.baseRev) {
            that.rebase();
            return {
                op: Synchronizer.OP_STALE,
                text: Synchronizer.TEXT_STALE,
                newRev: that.baseRev,
                model: that.baseModel,
            }
        }
        var response = {};
        var baseModel = that.baseModel;
        if (request.diff) {
            JsonUtil.applyJson(that.model, request.diff);
            JsonUtil.applyJson(baseModel, request.diff);
        }
        that.rebase();
        var diff = JsonUtil.diffUpsert(that.model, baseModel);
        //console.log("UPDATE model:" + JSON.stringify(that.model), " baseModel:" + JSON.stringify(baseModel));
        if (diff == null) {
            response.op = Synchronizer.OP_OK;
            response.text = request.diff ? Synchronizer.TEXT_UPDATED : Synchronizer.TEXT_IDLE;
            response.syncRev = request.syncRev;
        } else {
            response.op = Synchronizer.OP_UPDC;
            response.diff = diff;
            response.text = Synchronizer.TEXT_UPDC;
            response.syncRev = request.syncRev;
            response.newRev = that.baseRev;
        }
        return response;
    }
    Synchronizer.prototype.sync_updc = function(request) {
        var that = this;
        if (request.op !== Synchronizer.OP_UPDC) {
            return null;
        }
        if (!request.hasOwnProperty("diff")) {
            return that.createErrorResponse(request, Synchronizer.ERR_DIFF);
        } else if (!request.hasOwnProperty("newRev")) {
            return that.createErrorResponse(request, Synchronizer.ERR_NEWREV);
        } else if (!request.hasOwnProperty("syncRev")) {
            return that.createErrorResponse(request, Synchronizer.ERR_SYNCREV);
        } else if (request.syncRev !== that.syncRev) {
            return that.createErrorResponse(request, Synchronizer.ERR_STALE);
        }

        var response = {};
        that.syncRev = request.newRev;
        response.syncRev = that.syncRev;
        JsonUtil.applyJson(that.model, request.diff);
        that.rebase();
        response.op = Synchronizer.OP_OK;
        response.text = Synchronizer.TEXT_UPDATED;
        return response;
    }
    Synchronizer.prototype.sync = function(request) {
        var that = this;
        request = request || { 
            op: Synchronizer.OP_CLONE,
        };
        if (request.op == null) {
            return that.createErrorResponse(request, Synchronizer.ERR_OP);
        }
        var response = that.sync_clone(request) ||
            that.sync_echo(request, Synchronizer.OP_ERR) ||
            that.sync_echo(request, Synchronizer.OP_OK) ||
            that.sync_echo(request, Synchronizer.OP_NOP) ||
            that.sync_echo(request, Synchronizer.OP_RETRY) ||
            that.sync_updb(request) ||
            that.sync_updc(request) ||
            that.sync_stale(request) ||
            that.sync_sync(request);
        if (!response) {
            throw new Error("Synchronizer.sync() unhandled request:" + JSON.stringify(request));
        }
        return response;
    }

    Synchronizer.TEXT_RETRY = "Retry: base model uninitialized";
    Synchronizer.TEXT_SYNC = "Synchronize: response includes base model";
    Synchronizer.TEXT_STALE = "Stale: clone UPDB ignored. Response includes base model";
    Synchronizer.TEXT_UPDATED = "Updated: model synchronized";
    Synchronizer.TEXT_UPDC = "Synchronize: base updated with diff for clone";
    Synchronizer.TEXT_REBASE = "Rebase: stale request ignored";
    Synchronizer.TEXT_INITIALIZED = "Initialized: models are synchronized";
    Synchronizer.TEXT_IDLE = "Idle: no changes to base or clone models";
    Synchronizer.ERR_OP = "Error: op expected";
    Synchronizer.ERR_MODEL = "Error: model expected";
    Synchronizer.ERR_NEWREV = "Error: newRev expected";
    Synchronizer.ERR_SYNCREV = "Error: syncRev expected";
    Synchronizer.ERR_DIFF = "Error: diff expected";
    Synchronizer.ERR_STALE = "Error: unknown syncRev for clone";
    Synchronizer.OP_CLONE = "CLONE";
    Synchronizer.OP_RETRY = "RETRY";
    Synchronizer.OP_SYNC = "SYNC"; 
    Synchronizer.OP_STALE = "STALE"; 
    Synchronizer.OP_UPDB = "UPDB";
    Synchronizer.OP_UPDC = "UPDC";
    Synchronizer.OP_NOP = "NOP";
    Synchronizer.OP_OK = "OK";
    Synchronizer.OP_ERR = "ERR";

    Synchronizer.revision = function(model) {
        if (typeof model === 'string') {
            var json = model;
        } else {
            var json = model == null ? "" : JSON.stringify(model);
        }
        if (json.length === 0) {
            return 0;
        }
        var sum1 = 0;
        var sum2 = 0;
        var sum3 = 0;
        var sum5 = 0;
        var sum7 = 0;
        var sum11 = 0;
        var sum13 = 0;
        for (var i = json.length; i-- > 0;) {
            var code = json.charCodeAt(i);
            sum1 += code;
            (i % 2 === 0) && (sum2 += code);
            (i % 3 === 0) && (sum3 += code);
            (i % 5 === 0) && (sum5 += code);
            (i % 7 === 0) && (sum7 += code);
            (i % 11 === 0) && (sum11 += code);
            (i % 13 === 0) && (sum13 += code);
        }
        var result = (json.length + 1) / (sum1 + 1) + ((sum2 << 2) ^ (sum3 << 3) ^ (sum5 << 5) ^ (sum7 << 7) ^ (sum11 << 11) ^ (sum13 << 13));
        //console.log("Synchronizer.revision()", result, " json:", json);
        return result;
    }

    module.exports = exports.Synchronizer = Synchronizer;
})(typeof exports === "object" ? exports : (exports = {}));

// mocha -R min --inline-diffs *.js
(typeof describe === 'function') && describe("Synchronizer", function() {
    var Synchronizer = exports.Synchronizer;
    var decorateBase = function(model) {
        model.d = model.d ? model.d + 10 : 10;
    }
    var baseOptions = {
        verbose: true,
        decorate: decorateBase,
    };
    var testScenario= function(isRebase, isSync) {
        var scenario = {
            baseModel: {
                a:1
            },
            cloneModel: {},
        };
        scenario.baseSync = new Synchronizer(scenario.baseModel, baseOptions);
        scenario.cloneSync = new Synchronizer(scenario.cloneModel);
        isRebase && scenario.baseSync.rebase();
        if (isSync) {
            scenario.cloneSync.sync(
                scenario.baseSync.sync(
                    scenario.cloneSync.createSyncRequest()));
            should.deepEqual(scenario.cloneModel, scenario.baseModel);
        }
        return scenario;
    }
    it("sync() returns initial synchronization model", function() {
        var baseModel = {
            a: 1,
        };
        var syncBase = new Synchronizer(baseModel, baseOptions);
        var expected1 = {
            op: Synchronizer.OP_RETRY,
            text: Synchronizer.TEXT_RETRY,
        };
        should.deepEqual(syncBase.sync(), expected1);
        should.deepEqual(syncBase.sync(), expected1); // idempotent

        // base model changes but remains uninitialized
        baseModel.a = 2;
        should.deepEqual(syncBase.sync(), expected1);
        should.deepEqual(syncBase.sync(), expected1); // idempotent

        // rebase() marks first synchronizable version
        should.deepEqual(syncBase.rebase(), syncBase);
        var modelExpected = {
            a: 2,
            d: 10,
        };
        should.deepEqual(syncBase.sync(), {
            op: Synchronizer.OP_SYNC,
            newRev: syncBase.baseRev,
            text: Synchronizer.TEXT_SYNC,
            model: modelExpected,
        });

        // base model changes 
        baseModel.a = 3;
        var modelExpected3 = {
            a: 3,
            d: 20,
        };
        var expected3 = {
            op: Synchronizer.OP_SYNC,
            text: Synchronizer.TEXT_SYNC,
            newRev: Synchronizer.revision(modelExpected3),
            model: modelExpected3,
        };
        should.deepEqual(syncBase.sync(), expected3);
        should.deepEqual(syncBase.sync(), expected3); // idempotent
        
    });
    it("rebase() marks model as initialized", function() {
        var baseModel = {
            a: 1,
        };
        var syncBase = new Synchronizer(baseModel, baseOptions);
        var modelExpected = {
            a: 1,
            d: 10,
        };
        var expected1 = {
            op: Synchronizer.OP_SYNC,
            text: Synchronizer.TEXT_SYNC,
            newRev: Synchronizer.revision(modelExpected),
            model: modelExpected,
        }
        should.deepEqual(syncBase.rebase(), syncBase);
        should.deepEqual(syncBase.sync(), expected1);
    });
    it("sync(initial) initializes clone model", function() {
        var baseModel = {
            a: {
                aa: 1
            },
        };
        var syncBase = new Synchronizer(baseModel, baseOptions);
        var clonea = {
            aa: 2,
        };
        var cloneModel = {
            a: clonea,
        };
        var syncClone = new Synchronizer(cloneModel);

        // nothing should happen with uninitialized models
        var initial = syncBase.sync();
        var expected1 = {
            op: Synchronizer.OP_RETRY,
            text: Synchronizer.TEXT_RETRY,
        };
        should.deepEqual(initial, expected1);
        should.deepEqual(syncClone.sync(initial), expected1);
        should.deepEqual(syncClone.sync(initial), expected1); // idempotent
        syncBase.rebase();

        // error message
        should.deepEqual(syncClone.sync({
            newRev: 1,
        }), {
            op: Synchronizer.OP_ERR,
            text: Synchronizer.ERR_OP,
        });
        should.deepEqual(syncClone.sync({
            op: Synchronizer.OP_SYNC,
            newRev: 1,
        }), {
            op: Synchronizer.OP_ERR,
            text: Synchronizer.ERR_MODEL
        });
        should.deepEqual(syncClone.sync({
            op: Synchronizer.OP_SYNC,
            model:{},
        }), {
            op: Synchronizer.OP_ERR,
            text: Synchronizer.ERR_NEWREV,
        });

        // synchronize to base model
        clonea.aa.should.equal(2);
        initial = syncBase.sync(); // OP_SYNC
        var expectedSync = {
            op: Synchronizer.OP_OK,
            syncRev: syncBase.baseRev,
            text: Synchronizer.TEXT_INITIALIZED,
        };
        should.deepEqual(syncClone.sync(initial), expectedSync);
        should.deepEqual(cloneModel, baseModel);
        //JSON.stringify(cloneModel).should.equal(JSON.stringify(baseModel));
        syncBase.baseRev.should.equal(syncClone.baseRev);
        // IMPORTANT: synchronization should maintain clone structure
        clonea.aa.should.equal(1);
        should.deepEqual(syncClone.sync(initial), expectedSync); // idempotent

        // re-synchronizate after clone changes 
        cloneModel.a.aa = 11;
        cloneModel.c = 3;
        should.deepEqual(syncClone.sync(initial), expectedSync);
        cloneModel.a.aa.should.equal(1); // synchronize overwrites change to base model attribute
        cloneModel.c.should.equal(3); // synchronize ignores non base model attribute
    });
    it("revision(model) returns the revision hash code for the given model", function() {
        var j1 = {
            a: 1,
        };
        Synchronizer.revision({
            a: 1
        }).should.equal(827036.0153550864);
        Synchronizer.revision(JSON.stringify(j1)).should.equal(827036.0153550864);
        Synchronizer.revision("").should.equal(0);
        Synchronizer.revision().should.equal(0);
    });
    it("3-step synchronization should initialize clone", function() {
        var so = testScenario(true, false);
        var messages = [];
        messages.push(so.cloneSync.createSyncRequest()); // step 1
        messages.push(so.baseSync.sync(messages[0]));    // step 2
        messages.push(so.cloneSync.sync(messages[1]));   // step 3

        should.deepEqual(messages[0], {
            op: Synchronizer.OP_CLONE,
        });
        var model2 = {
            a: 1,
            d: 10,
        };
        should.deepEqual(messages[1], {
            op: Synchronizer.OP_SYNC,
            text: Synchronizer.TEXT_SYNC,
            newRev: so.baseSync.baseRev,
            model: model2,
        });
        so.baseSync.baseRev.should.equal(Synchronizer.revision(model2));
        should.deepEqual(messages[2], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_INITIALIZED,
            syncRev: so.baseSync.baseRev,
        });
        should.deepEqual(so.cloneModel, so.baseModel);
        should.deepEqual(so.baseModel, {
            a: 1,
            d: 10,
        });
        so.cloneSync.syncRev.should.equal(so.baseSync.baseRev);
    });
    it("3-step synchronization should handle clone change", function() {
        var so = testScenario(true, true);
        var syncRev1 = so.cloneSync.syncRev; // initial syncRev
        so.cloneModel.b = 2; // clone change
        var messages = [];
        messages.push(so.cloneSync.createSyncRequest()); // step 1
        messages.push(so.baseSync.sync(messages[0]));    // step 2
        messages.push(so.cloneSync.sync(messages[1]));   // step 3
        should.deepEqual(messages[0], {
            op: Synchronizer.OP_UPDB,
            syncRev: syncRev1,
            diff: {
                b: 2, // clone change
            }
        });
        should.deepEqual(messages[1], {
            op: Synchronizer.OP_UPDC,
            text: Synchronizer.TEXT_UPDC,
            syncRev: messages[0].syncRev,
            newRev: so.baseSync.baseRev,
            diff: {
                d: 20, // base decoration 
            }
        });
        should.deepEqual(messages[2], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_UPDATED,
            syncRev: so.baseSync.baseRev,
        });
        should.deepEqual(so.cloneModel, so.baseModel);
    });
    it("3-step synchronization should handle no changes", function() {
        var so = testScenario(true, true);
        var messages = [];
        messages.push(so.cloneSync.createSyncRequest()); // step 1
        messages.push(so.baseSync.sync(messages[0]));    // step 2
        messages.push(so.cloneSync.sync(messages[1]));   // step 3
        should.deepEqual(messages[0], {
            op: Synchronizer.OP_UPDB,
            syncRev: so.cloneSync.syncRev,
        });
        should.deepEqual(messages[1], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_IDLE,
            syncRev: messages[0].syncRev,
        });
        should.deepEqual(messages[2], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_IDLE,
            syncRev: messages[0].syncRev,
        });
        should.deepEqual(so.cloneModel, so.baseModel);
    });
    it("3-step synchronization should handle base changes", function() {
        var so = testScenario(true, true);
        var syncRev1 = so.baseSync.baseRev;
        so.baseModel.a = 11; // base change
        var messages = [];
        messages.push(so.cloneSync.createSyncRequest()); // step 1
        messages.push(so.baseSync.sync(messages[0]));    // step 2
        messages.push(so.cloneSync.sync(messages[1]));   // step 3
        should.deepEqual(messages[0], {
            op: Synchronizer.OP_UPDB,
            syncRev: syncRev1,
        });
        should.deepEqual(messages[1], {
            op: Synchronizer.OP_UPDC,
            text: Synchronizer.TEXT_UPDC,
            syncRev: messages[0].syncRev,
            newRev: so.baseSync.baseRev,
            diff: {
                a: 11, // base change
                d: 20, // base decoration
            }
        });
        should.deepEqual(messages[2], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_UPDATED,
            syncRev: so.baseSync.baseRev,
        });
        should.deepEqual(so.cloneModel, so.baseModel);
        should.deepEqual(so.cloneModel, {
            a: 11,
            d: 20,
        });
    });
    it("3-step synchronization should handle base+clone changes", function() {
        var so = testScenario(true, true);
        var syncRev1 = so.baseSync.baseRev;
        so.baseModel.a = 11; // base change
        so.cloneModel.b = 2; // clone change
        var messages = [];
        messages.push(so.cloneSync.createSyncRequest()); // step 1
        messages.push(so.baseSync.sync(messages[0]));    // step 2
        messages.push(so.cloneSync.sync(messages[1]));   // step 3
        should.deepEqual(messages[0], {
            op: Synchronizer.OP_UPDB,
            syncRev: syncRev1,
            diff: {
                b: 2,
            }
        });
        should.deepEqual(messages[1], {
            op: Synchronizer.OP_UPDC,
            text: Synchronizer.TEXT_UPDC,
            syncRev: messages[0].syncRev,
            newRev: so.baseSync.baseRev,
            diff: {
                a: 11, // base change
                d: 20, // base decoration
            }
        });
        should.deepEqual(messages[2], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_UPDATED,
            syncRev: so.baseSync.baseRev,
        });
        should.deepEqual(so.cloneModel, so.baseModel);
        should.deepEqual(so.cloneModel, {
            a: 11,
            b: 2,
            d: 20,
        });
    });
    it("3-step synchronization should slam base model over stale clone", function() {
        var so = testScenario(true, true);
        var syncRev1 = so.baseSync.baseRev;
        so.baseModel.a = 11; // base change
        so.baseSync.rebase(); // make clone stale 
        syncRev1.should.not.equal(so.baseSync.baseRev);
        var messages = [];
        messages.push(so.cloneSync.createSyncRequest()); // step 1
        messages.push(so.baseSync.sync(messages[0]));    // step 2
        messages.push(so.cloneSync.sync(messages[1]));   // step 3
        should.deepEqual(messages[0], {
            op: Synchronizer.OP_UPDB,
            syncRev: syncRev1,
        });
        should.deepEqual(messages[1], {
            op: Synchronizer.OP_STALE,
            text: Synchronizer.TEXT_STALE,
            newRev: so.baseSync.baseRev,
            model: {
                a: 11,
                d: 20, 
            }
        });
        should.deepEqual(messages[2], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_INITIALIZED,
            syncRev: so.baseSync.baseRev,
        });
        should.deepEqual(so.baseModel, {
            a: 11,
            d: 20,
        });
        should.deepEqual(so.cloneModel, {
            a: 11, 
            d: 20,
        });
    });
    it("3-step synchronization of stale clone will be unfriendly to clone changes", function() {
        var so = testScenario(true, true);
        var syncRev1 = so.baseSync.baseRev;
        so.baseModel.a = 11; // base change
        so.baseSync.rebase(); // make clone stale 
        syncRev1.should.not.equal(so.baseSync.baseRev);
        so.cloneModel.a = 10; // clone change
        so.cloneModel.b = 2; // clone change
        var messages = [];
        messages.push(so.cloneSync.createSyncRequest()); // step 1
        messages.push(so.baseSync.sync(messages[0]));    // step 2
        messages.push(so.cloneSync.sync(messages[1]));   // step 3
        should.deepEqual(messages[0], {
            op: Synchronizer.OP_UPDB,
            syncRev: syncRev1,
            diff: {
                a: 10,
                b: 2,
            }
        });
        should.deepEqual(messages[1], {
            op: Synchronizer.OP_STALE,
            text: Synchronizer.TEXT_STALE,
            newRev: so.baseSync.baseRev,
            model: {
                a: 11,
                d: 20, 
            }
        });
        should.deepEqual(messages[2], {
            op: Synchronizer.OP_OK,
            text: Synchronizer.TEXT_INITIALIZED,
            syncRev: so.baseSync.baseRev,
        });
        should.deepEqual(so.baseModel, {
            a: 11,
            d: 20,
        });
        // TODO: The following outcome is ugly
        should.deepEqual(so.cloneModel, {
            a: 11, // base value slammed over clone change (ugh)
            b: 2, // orphaned clone value won't sync till changed (ugh)
            d: 20,
        });
    });
})