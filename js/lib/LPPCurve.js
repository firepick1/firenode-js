var should = require("should"),
    module = module || {},
    firepick = firepick || {};
Logger = require("./Logger");
PHFeed = require("./PHFeed");
PH5Curve = require("./PH5Curve");
PHFactory = require("./PHFactory");
DeltaCalculator = require("./DeltaCalculator");
DataSeries = require("./DataSeries");
DVSFactory = require("./DVSFactory");
math = require("mathjs");

(function(firepick) {
    function LPPCurve(options) {
        var that = this;
        options = options || {};
        that.delta = options.delta || new DeltaCalculator();
        that.pathSize = options.pathSize || 80; // number of path segments
        that.zVertical = options.zVertical || 5; // mm vertical travel
        that.vMax = 18000; // 100mm in 1s 
        that.tvMax = 0.7; // 100mm in 1s
        that.deltaSmoothness = 8; // delta path smoothness convergence threshold
        that.zHigh = options.zHigh == null ? 50 : options.zHigh; // highest point of LPP path
        that.zScale = options.zScale || 1; // DEPRECATED
        that.logger = options.logger || new Logger(options);
        return that;
    };

    ///////////////// INSTANCE ///////////////

    LPPCurve.prototype.geometricPath = function(x, y, z) {
        var that = this;
        var delta = that.delta;
        var pts = [];
        var pathSize2 = that.pathSize / 2;
        var height = that.zHigh - z;
        var dz = height / (that.pathSize - 1);
        for (var i = 0; i < that.pathSize; i++) {
            var pulses = (i < pathSize2) ?
                delta.calcPulses({
                    x: 0,
                    y: 0,
                    z: that.zHigh - i * dz
                }) :
                delta.calcPulses({
                    x: x,
                    y: y,
                    z: that.zHigh - i * dz
                });
            pts.push(pulses);
        }
        var start = math.round(that.zVertical / dz);
        var ds = new DataSeries({
            start: start,
            end: -start,
            round: true
        });
        var maxIterations = 50;
        var d1Prev;
        var d2Prev;
        var d3Prev;
        for (var i = 0; i++ < maxIterations;) {
            //that.logger.withPlaces(5).debug(i, "\t", pts[start+1]);
            ds.blur(pts, "p1");
            ds.blur(pts, "p2");
            ds.blur(pts, "p3");
            var d1 = ds.diff(pts, "p1");
            if (d1Prev != null) {
                if (math.abs(d1Prev.max - d1.max) < that.deltaSmoothness) {
                    that.logger.debug("deltaSmoothness p1 converged:", i);
                    var d2 = ds.diff(pts, "p2");
                    if (d2Prev != null) {
                        if (math.abs(d2Prev.max - d2.max) < that.deltaSmoothness) {
                            that.logger.debug("deltaSmoothness p2 converged:", i);
                            var d3 = ds.diff(pts, "p3");
                            if (d3Prev != null) {
                                if (math.abs(d3Prev.max - d3.max) < that.deltaSmoothness) {
                                    that.logger.debug("deltaSmoothness p3 converged:", i);
                                    break;
                                }
                            }
                            d3Prev = d3;
                        }
                    }
                    d2Prev = d2;
                }
            }
            //that.logger.debug("geometricPath blur diff:", ds.diff(pts, "p1"));
            d1Prev = d1;
        }

        // final smoothing pass
        ds.start = 0;
        ds.end = 0;
        ds.blur(pts, "p1");
        ds.blur(pts, "p2");
        ds.blur(pts, "p3");

        for (var i = 0; i < that.pathSize; i++) {
            var xyz = delta.calcXYZ(pts[i]);
            pts[i].x = xyz.x;
            pts[i].y = xyz.y;
            pts[i].z = xyz.z;
        }
        return pts;
    }
    LPPCurve.prototype.timedPath = function(x, y, z) {
        var that = this;
        var geometry = that.geometricPath(x, y, z);
        var zr = [];
        for (var i = 0; i < geometry.length; i++) {
            var pt = geometry[i];
            var r = math.sqrt(pt.x * pt.x + pt.y * pt.y);
            var c = new Complex(pt.z, r);
            zr.push(c);
        }
        zr.reverse();
        var ph = new PHFactory(zr).quintic();
        var xyzHigh = that.delta.calcXYZ({
            p1: 500,
            p2: 500,
            p3: 500
        });
        var xyzLow = that.delta.calcXYZ({
            p1: -500,
            p2: -500,
            p3: -500
        });
        var vMax = math.abs(xyzHigh.z - xyzLow.z) * that.vMax / 1000;
        var phf = new PHFeed(ph, {
            vMax: vMax,
            tvMax: 0.7,
        });
        var pts = phf.interpolate(that.pathSize, {});
        pts.reverse();
        var radius = math.sqrt(x * x + y * y);
        for (var i = 0; i < pts.length; i++) {
            var pt = pts[i];
            var scale = radius ? pt.r.im / radius : 1;
            pt.x = x * scale;
            pt.y = y * scale;
            pt.z = pt.r.re;
            var pulses = that.delta.calcPulses({
                x: pt.x,
                y: pt.y,
                z: pt.z
            });
            pt.p1 = pulses.p1;
            pt.p2 = pulses.p2;
            pt.p3 = pulses.p3;
        }
        var height = that.zHigh - z;
        var dz = height / (that.pathSize - 1);
        var start = 0; //math.round(that.zVertical/dz);
        var ds = new DataSeries({
            start: start,
            end: -start,
            round: true
        });
        var iterations = 30;
        var isMonotonic = false;
        var i;
        for (i = 0; i < iterations; i++) {
            var diff1 = ds.diff(pts, "p1");
            if (diff1.min >= 0) {
                var diff2 = ds.diff(pts, "p2");
                if (diff2.min >= 0) {
                    var diff3 = ds.diff(pts, "p3");
                    if (diff3.min >= 0) {
                        i++;
                        isMonotonic = true;
                        break;
                    }
                }
            }
            ds.blur(pts, "p1");
            ds.blur(pts, "p2");
            ds.blur(pts, "p3");
        }
        that.logger.debug("timedPath monotonic:", isMonotonic, " iterations:", i);
        var ptPrev = pts[0];
        for (var i = 0; i < pts.length; i++) {
            var pt = pts[i];
            pt.dp1 = pt.p1 - ptPrev.p1;
            ptPrev = pt;
            var xyz = that.delta.calcXYZ({
                p1: pt.p1,
                p2: pt.p2,
                p3: pt.p3
            });
            pt.x = xyz.x;
            pt.y = xyz.y;
            pt.z = xyz.z;
        }
        return pts;
    }

    ///////////////// CLASS //////////

    Logger.logger.debug("loaded firepick.LPPCurve");
    module.exports = firepick.LPPCurve = LPPCurve;
})(firepick || (firepick = {}));

(typeof describe === 'function') && describe("firepick.LPPCurve", function() {
    var logger = new Logger({
        nPlaces: 3,
        logLevel: "info"
    });
    var LPPCurve = firepick.LPPCurve;
    var eMicrostep = 0.025;
    it("geometricPath(x,y,z) should return XYZ path", function() {
        var lpp = new LPPCurve();
        var x = -70.7;
        var y = 70.7;
        var z = -10;
        var pts = lpp.geometricPath(x, y, z);
        logger.debug("#", "\tdp1\tp1\tp2\tp3", "\tx\ty\tz", "\txa\tya\tza");
        var ptPrev = pts[0];
        var maxp1 = 0;
        var maxp2 = 0;
        var maxp3 = 0;
        for (var i = 0; i < pts.length; i++) {
            var pt = pts[i];
            logger.debug(i,
                "\t", pt.p1 - ptPrev.p1,
                "\t", pt.p1,
                "\t", pt.p2,
                "\t", pt.p3,
                "\t", pt.x,
                "\t", pt.y,
                "\t", pt.z
            );
            maxp1 = math.max(maxp1, math.abs(pt.p1 - ptPrev.p1));
            maxp2 = math.max(maxp2, math.abs(pt.p2 - ptPrev.p2));
            maxp3 = math.max(maxp3, math.abs(pt.p3 - ptPrev.p3));
            ptPrev = pt;
            if (pt.z > lpp.zHigh - lpp.zVertical) {
                math.abs(pt.x).should.below(0.1);
                math.abs(pt.y).should.below(0.1);
            }
            if (z + lpp.zVertical > pt.z) {
                math.abs(x - pt.x).should.below(0.1);
                math.abs(y - pt.y).should.below(0.1);
            }
        }
        var ds = new DataSeries();
        var diff = ds.diff(pts, "z");
        diff.max.should.below(0); // z is monotonic decreasing
        diff = ds.diff(pts, "y");
        diff.min.should.above(-eMicrostep); // y is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "x");
        diff.max.should.below(eMicrostep); // x is monotonic decreasing within microstep tolerance
        logger.debug("max(abs()) p1:", maxp1, "\tp2:", maxp2, "\tp3:", maxp3);
    });
    it("geometricPath(x,y,z) should handle central paths", function() {
        var lpp = new LPPCurve();
        var x = 1;
        var y = 20;
        var z = 10;
        var pts = lpp.geometricPath(x, y, z);
        logger.debug("#", "\tdp1\tp1\tp2\tp3", "\tx\ty\tz", "\txa\tya\tza");
        var ptPrev = pts[0];
        var maxp1 = 0;
        var maxp2 = 0;
        var maxp3 = 0;
        for (var i = 0; i < pts.length; i++) {
            var pt = pts[i];
            logger.debug(i,
                "\t", pt.p1 - ptPrev.p1,
                "\t", pt.p1,
                "\t", pt.p2,
                "\t", pt.p3,
                "\t", pt.x,
                "\t", pt.y,
                "\t", pt.z
            );
            maxp1 = math.max(maxp1, math.abs(pt.p1 - ptPrev.p1));
            maxp2 = math.max(maxp2, math.abs(pt.p2 - ptPrev.p2));
            maxp3 = math.max(maxp3, math.abs(pt.p3 - ptPrev.p3));
            ptPrev = pt;
            if (pt.z > lpp.zHigh - lpp.zVertical) {
                math.abs(pt.x).should.below(0.1);
                math.abs(pt.y).should.below(0.1);
            }
            if (z + lpp.zVertical > pt.z) {
                math.abs(x - pt.x).should.below(0.1);
                math.abs(y - pt.y).should.below(0.1);
            }
        }
        var ds = new DataSeries();
        var diff = ds.diff(pts, "z");
        diff.max.should.below(0); // z is monotonic decreasing
        diff = ds.diff(pts, "y");
        diff.min.should.above(-eMicrostep); // y is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "x");
        diff.min.should.above(-eMicrostep); // x is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "p1");
        diff.min.should.above(0); // p1 is monotonic increasing
        diff = ds.diff(pts, "p2");
        diff.min.should.above(0); // p2 is monotonic increasing
        diff = ds.diff(pts, "p3");
        diff.min.should.above(0); // p3 is monotonic increasing
        logger.debug("max(abs()) p1:", maxp1, "\tp2:", maxp2, "\tp3:", maxp3);
    });
    it("geometricPath(x,y,z) should handle Z-axis paths", function() {
        var lpp = new LPPCurve();
        var x = 0;
        var y = 0;
        var z = -10;
        var pts = lpp.geometricPath(x, y, z);
        logger.debug("#", "\tdp1\tp1\tp2\tp3", "\tx\ty\tz", "\txa\tya\tza");
        var ptPrev = pts[0];
        var maxp1 = 0;
        var maxp2 = 0;
        var maxp3 = 0;
        for (var i = 0; i < pts.length; i++) {
            var pt = pts[i];
            logger.debug(i,
                "\t", pt.p1 - ptPrev.p1,
                "\t", pt.p1,
                "\t", pt.p2,
                "\t", pt.p3,
                "\t", pt.x,
                "\t", pt.y,
                "\t", pt.z
            );
            maxp1 = math.max(maxp1, math.abs(pt.p1 - ptPrev.p1));
            maxp2 = math.max(maxp2, math.abs(pt.p2 - ptPrev.p2));
            maxp3 = math.max(maxp3, math.abs(pt.p3 - ptPrev.p3));
            ptPrev = pt;
            if (pt.z > lpp.zHigh - lpp.zVertical) {
                math.abs(pt.x).should.below(0.1);
                math.abs(pt.y).should.below(0.1);
            }
            if (z + lpp.zVertical > pt.z) {
                math.abs(x - pt.x).should.below(0.1);
                math.abs(y - pt.y).should.below(0.1);
            }
        }
        var ds = new DataSeries();
        var diff = ds.diff(pts, "z");
        diff.max.should.below(0); // z is monotonic decreasing
        diff = ds.diff(pts, "y");
        diff.min.should.above(-eMicrostep); // y is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "x");
        diff.min.should.above(-eMicrostep); // x is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "p1");
        diff.min.should.above(0); // p1 is monotonic increasing
        diff = ds.diff(pts, "p2");
        diff.min.should.above(0); // p2 is monotonic increasing
        diff = ds.diff(pts, "p3");
        diff.min.should.above(0); // p3 is monotonic increasing
        logger.debug("max(abs()) p1:", maxp1, "\tp2:", maxp2, "\tp3:", maxp3);
    });
    it("geometricPath(x,y,z) paths should work for DVSFactory", function() {
        var lpp = new LPPCurve({
            zHigh: 40
        });
        var x = 50;
        var y = 0;
        var z = -10;
        var pts = lpp.geometricPath(x, y, z);
        logger.debug("#", "\tdp1\tp1\tp2\tp3", "\tx\ty\tz", "\txa\tya\tza");
        var ptPrev = pts[0];
        var maxp1 = 0;
        var maxp2 = 0;
        var maxp3 = 0;
        for (var i = 0; i < pts.length; i++) {
            var pt = pts[i];
            logger.debug(i,
                "\t", pt.p1 - ptPrev.p1,
                "\t", pt.p1,
                "\t", pt.p2,
                "\t", pt.p3,
                "\t", pt.x,
                "\t", pt.y,
                "\t", pt.z
            );
            maxp1 = math.max(maxp1, math.abs(pt.p1 - ptPrev.p1));
            maxp2 = math.max(maxp2, math.abs(pt.p2 - ptPrev.p2));
            maxp3 = math.max(maxp3, math.abs(pt.p3 - ptPrev.p3));
            ptPrev = pt;
            if (pt.z > lpp.zHigh - lpp.zVertical) {
                math.abs(pt.x).should.below(0.1);
                math.abs(pt.y).should.below(0.1);
            }
            if (z + lpp.zVertical > pt.z) {
                math.abs(x - pt.x).should.below(0.1);
                math.abs(y - pt.y).should.below(0.1);
            }
        }
        var cmd = new DVSFactory().createDVS(pts);
        logger.debug(JSON.stringify(cmd));
    });
    it("timedPath(x,y,z) path should accelerate smoothly ", function() {
        var lpp = new LPPCurve();
        var pts = lpp.timedPath(70, 50, -10);
        var N = pts.length;
        for (var i = 0; i < N; i++) {
            var pt = pts[i];
            logger.debug(
                "\t", pt.t,
                "\t", pt.dp1,
                "\t", pt.p1,
                "\t", pt.p2,
                "\t", pt.p3,
                "\t", pt.x,
                "\t", pt.y,
                "\t", pt.z,
                ""
            );
        }
        var ds = new DataSeries();
        var diff = ds.diff(pts, "z");
        diff.max.should.below(0); // z is monotonic decreasing
        diff = ds.diff(pts, "y");
        diff.min.should.above(-eMicrostep); // y is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "x");
        diff.min.should.above(-eMicrostep); // x is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "p1");
        diff.min.should.above(0); // p1 is monotonic increasing
        diff = ds.diff(pts, "p2");
        diff.min.should.above(0); // p2 is monotonic increasing
        diff = ds.diff(pts, "p3");
        diff.min.should.above(0); // p3 is monotonic increasing

        // gentle start
        math.abs(pts[1].p1 - pts[0].p1).should.below(35);
        math.abs(pts[2].p2 - pts[1].p2).should.below(35);
        math.abs(pts[3].p3 - pts[2].p3).should.below(35);

        // very gentle stop
        math.abs(pts[N - 1].p1 - pts[N - 2].p1).should.below(10);
        math.abs(pts[N - 1].p2 - pts[N - 2].p2).should.below(10);
        math.abs(pts[N - 1].p3 - pts[N - 2].p3).should.below(10);
    });
    it("timedPath(x,y,z) path should handle X0Y0", function() {
        var lpp = new LPPCurve();
        var pts = lpp.timedPath(0, 0, -10);
        var N = pts.length;
        for (var i = 0; i < N; i++) {
            var pt = pts[i];
            logger.debug(
                "\t", pt.t,
                "\t", pt.dp1,
                "\t", pt.p1,
                "\t", pt.p2,
                "\t", pt.p3,
                "\t", pt.x,
                "\t", pt.y,
                "\t", pt.z,
                ""
            );
        }
        var ds = new DataSeries();
        var diff = ds.diff(pts, "z");
        diff.max.should.below(eMicrostep); // z is monotonic decreasing
        diff = ds.diff(pts, "y");
        diff.min.should.above(-eMicrostep); // y is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "x");
        diff.min.should.above(-eMicrostep); // x is monotonic increasing within microstep tolerance
        diff = ds.diff(pts, "p1");
        diff.min.should.not.below(0); // p1 is monotonic increasing
        diff = ds.diff(pts, "p2");
        diff.min.should.not.below(0); // p2 is monotonic increasing
        diff = ds.diff(pts, "p3");
        diff.min.should.not.below(0); // p3 is monotonic increasing

        // gentle start
        math.abs(pts[1].p1 - pts[0].p1).should.below(35);
        math.abs(pts[2].p2 - pts[1].p2).should.below(35);
        math.abs(pts[3].p3 - pts[2].p3).should.below(35);

        // very gentle stop
        math.abs(pts[N - 1].p1 - pts[N - 2].p1).should.below(10);
        math.abs(pts[N - 1].p2 - pts[N - 2].p2).should.below(10);
        math.abs(pts[N - 1].p3 - pts[N - 2].p3).should.below(10);
    });
    it("timedPath(x,y,z) paths should work for DVSFactory", function() {
        var lpp = new LPPCurve({
            zHigh: 40
        });
        var x = 50;
        var y = 0;
        var z = -10;
        var pts = lpp.timedPath(x, y, z);
        var cmd = new DVSFactory().createDVS(pts);
        should.deepEqual(cmd, {
            dvs: {
                '1': '05FE000000FF010002010303040404040403040405040503FFFEF9F8F5F8F8FAFEFF020305050507' +
                     '0505030502030102010000FF00FEFDFEFDFDFCFBFDFBFDFDFCFEFDFEFDFFFFFD00FFFFFF000000',
                '2': '05FE000000FF01000201030304040404040304030505030300FDFAF7F7F7F9FAFDFE010002020000' +
                     'FE00FDFD000002030607070706050302FFFEFDFDFBFDFCFCFDFCFEFEFDFFFEFEFFFFFFFF000000',
                '3': '05FE000000FF01000201030304040404040304050406040301FCFAF6F7F6F8FBFD010306070A0A0C' +
                     '0C0B0B0907040100FBFAF9F8F7F8F9F9FBFBFBFCFBFDFDFCFEFDFDFFFEFEFFFE00FE0000FE0100',
                dp: [6532, 4628, 8371],
                sc: 3,
                us: 1159241
            }
        });
    });
})