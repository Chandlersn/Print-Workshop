const photos = require('../../electron/photo-library.cjs')
const [datasetId, column, folder, taskId] = process.argv.slice(2)
photos.importFolder({ datasetId, column, folder, taskId, mode: 'replace' }, {
  onCheckpoint(phase) {
    if (phase === 'after-assets-staged') process.exit(73)
  },
}).then(() => process.exit(2), () => process.exit(3))
