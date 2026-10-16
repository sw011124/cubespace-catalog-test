// dir-list-mcp: lists file names and sizes in a directory. Read-only.
const fs = require("fs"), path = require("path");
function listDir(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
    name: d.name,
    dir: d.isDirectory(),
    size: d.isFile() ? fs.statSync(path.join(dir, d.name)).size : 0,
  }));
}
module.exports = { tools: { list_dir: listDir } };
