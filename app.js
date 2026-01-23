/* =========================
   Persistence (LocalStorage)
========================= */
const STORAGE_KEY = 'holdem_helper_state_v5';
let _saveQueued = false;

function safeParseJSON(s){
  try{ return JSON.parse(s); } catch{ return null; }
}
function saveStateDebounced(){
  if (_saveQueued) return;
  _saveQueued = true;
  requestAnimationFrame(()=>{
    _saveQueued = false;
    const st = {
      stage,
      opp: Number(oppEl.value),
      iters: Number(itersEl.value),
      calcMode: String(calcModeEl.value),
      pot: potEl.value,
      call: callEl.value,
      rankIdx,
      suitIdx,
    };
    try{ localStorage.setItem(STORAGE_KEY, JSON.stringify(st)); } catch {}
  });
}
function loadState(){
  const st = safeParseJSON(localStorage.getItem(STORAGE_KEY) || '');
  if (!st) return null;
  return st;
}

/* =========================
   Deck / Card Mapping
========================= */
const RANKS = '23456789TJQKA'.split('');
const SUITS = [
  {c:'s', sym:'♠', red:false},
  {c:'h', sym:'♥', red:true},
  {c:'d', sym:'♦', red:true},
  {c:'c', sym:'♣', red:false},
];

const CARD_IDS = [];
const ID_RANK = [];
const ID_SUIT = [];
const CODE_TO_ID = Object.create(null);

for (let si=0; si<4; si++){
  for (let ri=0; ri<13; ri++){
    const code = RANKS[ri] + SUITS[si].c;
    const id = CARD_IDS.length;
    CARD_IDS.push(code);
    ID_RANK.push(ri+2);
    ID_SUIT.push_
