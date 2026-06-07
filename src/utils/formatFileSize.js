function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  if (!bytes) return null;

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

module.exports = { formatFileSize };