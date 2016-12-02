'use strict';

var services = angular.module('firenodejs.services');

services.factory('firepaste-service', ['$http', 'AlertService', 'position-service',
    function($http, alerts, position) {
        var service = {
            isAvailable: function() {
                var kinematics = position.model.kinematics;
                service.model.available = kinematics.type === 'cartesian' &&
                    (kinematics.xAxis.minPos != null && kinematics.xAxis.maxPos != null) &&
                    (kinematics.yAxis.minPos != null && kinematics.yAxis.maxPos != null) &&
                    (kinematics.zAxis.minPos != null && kinematics.zAxis.maxPos != null) &&
                    (kinematics.xAxis.minLimit || kinematics.xAxis.maxLimit) &&
                    (kinematics.yAxis.minLimit || kinematics.yAxis.maxLimit) &&
                    (kinematics.zAxis.minLimit || kinematics.zAxis.maxLimit);
                return service.model.available === true;
            },
            model: {
            },
            getSyncJson: function() {
                return service.model;
            },
            syncModel: function(data) {
                if (data) {
                    JsonUtil.applyJson(service.model, data);
                    console.log("DEBUG syncModel(", data, ")");
                    console.log("DEBUG service.model", service.model);
                }
                return service.model;
            },
            calibrateBed: function() {
                alerts.danger("Not implemented");
            },
            calibrateYSkew: function() {
                alerts.danger("Not implemented");
            },
        };
        service.cfgAxis = position.model.kinematics && position.model.kinematics.xAxis;

        return service;
    }
]);
