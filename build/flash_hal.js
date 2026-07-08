/*
 * Emscripten JS library: binds the FASTFFS backend's flash HAL imports to the
 * JS-owned NOR device (web/src/device.js). The device is attached to the module
 * instance as `Module.flashDevice` after instantiation.
 */
mergeInto(LibraryManager.library, {
  js_flash_read: function (off, buffer, size) {
    return Module['flashDevice'].read(off >>> 0, buffer >>> 0, size >>> 0);
  },
  js_flash_prog: function (off, buffer, size) {
    return Module['flashDevice'].prog(off >>> 0, buffer >>> 0, size >>> 0);
  },
  js_flash_erase: function (off, size) {
    return Module['flashDevice'].erase(off >>> 0, size >>> 0);
  },
  // Silent read for inspection walks — no event, no stats, no simulated time.
  js_flash_read_quiet: function (off, buffer, size) {
    return Module['flashDevice'].readQuiet(off >>> 0, buffer >>> 0, size >>> 0);
  },
});
