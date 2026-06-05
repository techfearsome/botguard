// Re-export from uaParser module — keeps existing imports working
const { classifyDeviceClass, ALL_DEVICE_CLASSES } = require('./uaParser/deviceClass');
module.exports = { classifyDeviceClass, ALL_DEVICE_CLASSES };
