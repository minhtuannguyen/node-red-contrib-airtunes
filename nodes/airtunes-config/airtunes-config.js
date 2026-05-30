module.exports = function (RED) {
    function AirTunesConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.host = config.host;
        this.port   = parseInt(config.port, 10) || 7000;
        const v     = parseInt(config.volume, 10);
        this.volume = isNaN(v) ? 50 : v;
    }

    RED.nodes.registerType('airtunes-config', AirTunesConfigNode);
};
