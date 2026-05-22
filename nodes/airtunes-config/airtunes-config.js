module.exports = function (RED) {
    function AirTunesConfigNode(config) {
        RED.nodes.createNode(this, config);
        this.name = config.name;
        this.host = config.host;
        this.port = parseInt(config.port) || 7000;
        this.volume = parseInt(config.volume) || 50;
    }

    RED.nodes.registerType('airtunes-config', AirTunesConfigNode);
};
