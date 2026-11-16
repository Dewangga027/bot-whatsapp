'use strict';

const monitoring = require('./settings.fragment.cjs');

module.exports = {
  uiHost: '0.0.0.0',
  uiPort: 1880,
  flowFile: 'flows.json',
  flowFilePretty: true,
  httpAdminRoot: false,
  disableEditor: true,
  httpNodeRoot: '/',
  functionExternalModules: false,
  functionGlobalContext: monitoring.functionGlobalContext,
  contextStorage: { default: { module: 'memory' } },
  logging: { console: { level: 'warn', metrics: false, audit: false } },
  editorTheme: { projects: { enabled: false }, palette: { editable: false } },
};
