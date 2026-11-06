// Pakistani numbers ko ek hi format (03XXXXXXXXX) mein lata hai:
// 0300..., +92300..., 92300..., 0092300..., 300... sab same ban jate hain.
function normPhone(p) {
  if (!p) return null;
  let d = String(p).replace(/\D/g, '');
  if (d.startsWith('0092')) d = d.slice(4);
  else if (d.startsWith('92') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  if (d.length === 10 && d.startsWith('3')) return '0' + d;
  return d.length >= 7 ? d : null;
}

function phonesOf(list) {
  return [...new Set((list || []).map(normPhone).filter(Boolean))];
}

// "#1234", "1234", "# 1234" -> "1234". Order number ko courier ref se milane ke liye.
function normRef(s) {
  if (s === null || s === undefined) return null;
  const r = String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return r || null;
}

const DAY = 86400000;
const days = (ms) => Math.round((ms / DAY) * 10) / 10;

module.exports = { normPhone, phonesOf, normRef, DAY, days };
