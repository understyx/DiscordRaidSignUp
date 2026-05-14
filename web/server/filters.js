function registerFilters(njkEnv) {
  // dateformat filter: supports "%Y-%m-%d %H:%M", "%A, %d %B %Y %H:%M UTC", "%Y-%m-%d"
  njkEnv.addFilter('dateformat', (value, fmt) => {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
  
    const pad = n => String(n).padStart(2, '0');
    const year = d.getUTCFullYear();
    const month = pad(d.getUTCMonth() + 1);
    const day = pad(d.getUTCDate());
    const hours = pad(d.getUTCHours());
    const minutes = pad(d.getUTCMinutes());
  
    if (fmt === '%Y-%m-%d %H:%M') {
      return `${year}-${month}-${day} ${hours}:${minutes}`;
    }
  
    if (fmt === '%Y-%m-%d') {
      return `${year}-${month}-${day}`;
    }
  
    if (fmt === '%A, %d %B %Y %H:%M UTC') {
      const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ];
      const weekday = weekdays[d.getUTCDay()];
      const monthName = months[d.getUTCMonth()];
      return `${weekday}, ${day} ${monthName} ${year} ${hours}:${minutes} UTC`;
    }
  
    // Fallback: ISO
    return d.toISOString();
  });
  
  // int filter
  njkEnv.addFilter('int', val => Math.floor(Number(val)) || 0);
  
  // gsformat filter: formats a gearscore for display.
  // Returns "BiS" for the sentinel value (99999), otherwise the integer.
  njkEnv.addFilter('gsformat', val => {
    const n = Number(val);
    if (n >= 99999) return 'BiS';
    return Math.floor(n) || 0;
  });
  
  // map filter: extracts a named attribute from each item in an array
  // Usage: array | map('attrName')
  njkEnv.addFilter('map', (arr, attr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => (item != null && typeof item === 'object') ? item[attr] : undefined);
  });
  
  // tojson filter: serialize a value to a JSON string safe for inline <script> use
  njkEnv.addFilter('tojson', val => JSON.stringify(val));
  
  // discordId filter: shows last 6 digits of a Discord snowflake, e.g. "…789012"
  njkEnv.addFilter('discordId', val => {
    const s = String(val || '');
    if (!s || s === '0') return '?';
    return s.length > 6 ? '\u2026' + s.slice(-6) : s;
  });
}

module.exports = { registerFilters };
