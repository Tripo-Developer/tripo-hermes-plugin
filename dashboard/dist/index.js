// Tripo has no web-dashboard page. The manifest exists to mount plugin_api.py, which the Desktop half calls
// through ctx.rest; the dashboard still loads this entry, so it registers an empty page.
(function () {
  var plugins = window.__HERMES_PLUGINS__
  if (plugins && typeof plugins.register === 'function') {
    plugins.register('tripo', function TripoDashboardPlaceholder() {
      return null
    })
  }
})()
