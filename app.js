/* =========================
   Persistence (LocalStorage)
========================= */
const STORAGE_KEY = 'holdem_helper_state_v6';
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
    ID_SUIT.push(si);
    CODE_TO_ID[code]=id;
  }
}

function cardHTML(id){
  const code = CARD_IDS[id];
  const r = code[0];
  const s = code[1];
  const suit = SUITS.find(x=>x.c===s);
  const cls = suit.red ? 'suit-red' : 'suit-white';
  return `
    <div class="cardFace">
      <div class="mini">${r}<span class="${cls}">${suit.sym}</span></div>
      <div>${r}<span class="${cls}">${suit.sym}</span></div>
      <div class="mini2">${r}<span class="${cls}">${suit.sym}</span></div>
    </div>
  `;
}
function emptyHTML(){ return `<div class="emptyTxt">—</div>`; }

/* =========================
   Stronger RNG (crypto fallback)
========================= */
function randUint32(){
  if (globalThis.crypto && crypto.getRandomValues){
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] >>> 0;
  }
  return (Math.random() * 0x100000000) >>> 0;
}
function randInt(max){
  if (max <= 1) return 0;
  const limit = Math.floor(0x100000000 / max) * max;
  let x;
  do { x = randUint32(); } while (x >= limit);
  return x % max;
}

/* =========================
   7-card eval via 5-card combos
========================= */
const COMB_7C5 = [];
for (let a=0; a<7; a++)
for (let b=a+1; b<7; b++)
for (let c=b+1; c<7; c++)
for (let d=c+1; d<7; d++)
for (let e=d+1; e<7; e++)
  COMB_7C5.push([a,b,c,d,e]);

function packRanks(ranksDesc){
  let v = 0;
  for (let i=0;i<5;i++) v = (v << 4) | (ranksDesc[i] || 0);
  return v;
}
function eval5(ids5){
  const r = ids5.map(id => ID_RANK[id]).sort((a,b)=>b-a);
  const s0=ID_SUIT[ids5[0]], s1=ID_SUIT[ids5[1]], s2=ID_SUIT[ids5[2]], s3=ID_SUIT[ids5[3]], s4=ID_SUIT[ids5[4]];
  const isFlush = (s0===s1 && s1===s2 && s2===s3 && s3===s4);

  const counts = new Map();
  for (const x of r) counts.set(x, (counts.get(x)||0)+1);
  const groups = Array.from(counts.entries()).map(([rank,count])=>({rank,count}));
  groups.sort((a,b)=> (b.count-a.count) || (b.rank-a.rank));

  let straightHigh = 0;
  if (groups.length === 5){
    const uniqAsc = [...new Set(r)].sort((a,b)=>a-b);
    const min=uniqAsc[0], max=uniqAsc[4];
    if (max-min===4) straightHigh = max;
    else {
      const wheel = (uniqAsc[0]===2 && uniqAsc[1]===3 && uniqAsc[2]===4 && uniqAsc[3]===5 && uniqAsc[4]===14);
      if (wheel) straightHigh=5;
    }
  }

  if (straightHigh && isFlush) return (8<<20) | packRanks([straightHigh]);
  if (groups[0].count===4) return (7<<20) | packRanks([groups[0].rank, groups[1].rank]);
  if (groups[0].count===3 && groups[1].count===2) return (6<<20) | packRanks([groups[0].rank, groups[1].rank]);
  if (isFlush) return (5<<20) | packRanks(r);
  if (straightHigh) return (4<<20) | packRanks([straightHigh]);
  if (groups[0].count===3){
    const trip = groups[0].rank;
    const kickers = r.filter(x=>x!==trip);
    return (3<<20) | packRanks([trip, ...kickers]);
  }
  if (groups[0].count===2 && groups[1].count===2){
    const p1=groups[0].rank, p2=groups[1].rank;
    const hi=Math.max(p1,p2), lo=Math.min(p1,p2);
    const kicker = r.find(x=>x!==p1 && x!==p2);
    return (2<<20) | packRanks([hi,lo,kicker]);
  }
  if (groups[0].count===2){
    const pair=groups[0].rank;
    const kickers=r.filter(x=>x!==pair);
    return (1<<20) | packRanks([pair, ...kickers]);
  }
  return (0<<20) | packRanks(r);
}
function eval7(ids7){
  let best=-1;
  for (const idx of COMB_7C5){
    const v = eval5([ids7[idx[0]], ids7[idx[1]], ids7[idx[2]], ids7[idx[3]], ids7[idx[4]]]);
    if (v>best) best=v;
  }
  return best;
}

/* =========================
   Equity Engine + Cancel
========================= */
function buildRemainingDeck(used){
  const deck=[];
  for (let id=0; id<52; id++) if (!used.has(id)) deck.push(id);
  return deck;
}
function partialShuffle(deck, k){
  for (let i=0;i<k;i++){
    const j = i + randInt(deck.length - i);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}
function sleep0(){ return new Promise(r=>setTimeout(r,0)); }

function meanSeFromSums(sum, sumSq, n){
  const mean = sum/n;
  const varEst = Math.max(0, (sumSq/n) - mean*mean);
  const se = Math.sqrt(varEst/n);
  return {mean, se};
}

async function exactHeadsUpFromFlop(hero2, boardKnown, onProgress, shouldCancel){
  const known = boardKnown.slice();
  const missing = 5 - known.length;
  if (missing < 0 || missing > 2) throw new Error('Exact Heads-Up ist hier nur ab Flop (3 Boardkarten) sinnvoll.');
  if (known.length < 3) throw new Error('Exact Heads-Up erst ab Flop (3 Boardkarten).');

  const used0 = new Set([...hero2, ...known]);
  const deck0 = buildRemainingDeck(used0);

  let win=0, tie=0, lose=0;
  let equitySum = 0;

  const cancelCheck = () => { if (shouldCancel && shouldCancel()) throw new Error('CANCELLED'); };

  if (missing === 0){
    const board5 = known;
    const hv = eval7([hero2[0], hero2[1], board5[0], board5[1], board5[2], board5[3], board5[4]]);

    const totalOpp = (deck0.length * (deck0.length-1)) / 2;
    let done = 0;

    for (let i=0;i<deck0.length;i++){
      cancelCheck();
      for (let j=i+1;j<deck0.length;j++){
        const o1=deck0[i], o2=deck0[j];
        const ov = eval7([o1,o2, board5[0],board5[1],board5[2],board5[3],board5[4]]);
        if (hv>ov){ win++; equitySum+=1; }
        else if (hv===ov){ tie++; equitySum+=0.5; }
        else { lose++; }
      }
      done += (deck0.length - i - 1);
      if (i % 6 === 0){
        onProgress(Math.min(1, done/totalOpp));
        await sleep0();
      }
    }
  }

  if (missing === 1){
    const totalRunouts = deck0.length;
    for (let r=0;r<deck0.length;r++){
      cancelCheck();
      const river = deck0[r];
      const board5 = [...known, river];
      const hv = eval7([hero2[0], hero2[1], board5[0],board5[1],board5[2],board5[3],board5[4]]);

      const deck1 = [];
      for (let i=0;i<deck0.length;i++) if (i!==r) deck1.push(deck0[i]);

      for (let i=0;i<deck1.length;i++){
        for (let j=i+1;j<deck1.length;j++){
          const o1=deck1[i], o2=deck1[j];
          const ov = eval7([o1,o2, board5[0],board5[1],board5[2],board5[3],board5[4]]);
          if (hv>ov){ win++; equitySum+=1; }
          else if (hv===ov){ tie++; equitySum+=0.5; }
          else { lose++; }
        }
      }
      if (r % 2 === 0){
        onProgress(Math.min(1, (r+1)/totalRunouts));
        await sleep0();
      }
    }
  }

  if (missing === 2){
    const totalPairs = (deck0.length * (deck0.length-1)) / 2;
    let donePairs = 0;

    for (let a=0;a<deck0.length;a++){
      cancelCheck();
      for (let b=a+1;b<deck0.length;b++){
        const turn = deck0[a], river = deck0[b];
        const board5 = [...known, turn, river];
        const hv = eval7([hero2[0], hero2[1], board5[0],board5[1],board5[2],board5[3],board5[4]]);

        const deck1 = [];
        for (let i=0;i<deck0.length;i++){
          if (i!==a && i!==b) deck1.push(deck0[i]);
        }

        for (let i=0;i<deck1.length;i++){
          for (let j=i+1;j<deck1.length;j++){
            const o1=deck1[i], o2=deck1[j];
            const ov = eval7([o1,o2, board5[0],board5[1],board5[2],board5[3],board5[4]]);
            if (hv>ov){ win++; equitySum+=1; }
            else if (hv===ov){ tie++; equitySum+=0.5; }
            else { lose++; }
          }
        }

        donePairs++;
        if (donePairs % 28 === 0){
          onProgress(Math.min(1, donePairs/totalPairs));
          await sleep0();
        }
      }
    }
  }

  const total = win + tie + lose;
  return {
    equity: equitySum / total,
    winProb: win / total,
    tieProb: tie / total,
    loseProb: lose / total,
    states: total,
    mode: 'exact'
  };
}

async function monteCarloEquityAdaptive(hero2, boardKnown, opponents, opts, onProgress, shouldCancel){
  const {minIters, maxIters, targetHalfWidth95} = opts;

  const used = new Set([...hero2, ...boardKnown]);
  const deck = buildRemainingDeck(used);

  const needBoard = 5 - boardKnown.length;
  const needOpp = opponents*2;
  const need = needBoard + needOpp;

  let sum=0, sumSq=0, n=0;
  let win=0, tie=0, lose=0;

  const boardFull = new Array(5);
  for (let i=0;i<boardKnown.length;i++) boardFull[i]=boardKnown[i];

  const batch = 2200;
  const cancelCheck = () => { if (shouldCancel && shouldCancel()) throw new Error('CANCELLED'); };

  while (n < maxIters){
    cancelCheck();
    const end = Math.min(maxIters, n + batch);
    for (; n < end; n++){
      partialShuffle(deck, need);
      let p=0;

      for (let j=0;j<needBoard;j++){
        boardFull[boardKnown.length + j] = deck[p++];
      }

      const hv = eval7([hero2[0], hero2[1], boardFull[0], boardFull[1], boardFull[2], boardFull[3], boardFull[4]]);

      let best = hv, bestCount=1;
      let heroBest = true;

      for (let o=0;o<opponents;o++){
        const c1=deck[p++], c2=deck[p++];
        const ov = eval7([c1,c2, boardFull[0],boardFull[1],boardFull[2],boardFull[3],boardFull[4]]);
        if (ov > best){
          best = ov;
          bestCount = 1;
          heroBest = false;
        } else if (ov === best){
          bestCount++;
        }
        if (ov > hv) heroBest = false;
      }

      let outcome = 0;
      if (heroBest && hv === best){
        outcome = 1 / bestCount;
        if (bestCount === 1) win++;
        else tie++;
      } else {
        lose++;
      }

      sum += outcome;
      sumSq += outcome*outcome;
    }

    const {mean, se} = meanSeFromSums(sum, sumSq, n);
    const half = 1.96 * se;

    onProgress(n / maxIters);

    if (n >= minIters && half <= targetHalfWidth95){
      return {
        equity: mean,
        se,
        iters: n,
        winProb: win/n,
        tieProb: tie/n,
        loseProb: lose/n,
        half95: half,
        mode: 'mc'
      };
    }
    await sleep0();
  }

  const {mean, se} = meanSeFromSums(sum, sumSq, n);
  return {
    equity: mean,
    se,
    iters: n,
    winProb: win/n,
    tieProb: tie/n,
    loseProb: lose/n,
    half95: 1.96*se,
    mode: 'mc'
  };
}

/* =========================
   Current Hand Name
========================= */
const CAT_DE = [
  'Hohe Karte',
  'Ein Paar',
  'Zwei Paare',
  'Drilling',
  'Straße',
  'Flush',
  'Full House',
  'Vierling',
  'Straight Flush'
];
function getStraightHighFromPacked(packed20){
  return (packed20 >>> 16) & 0xF;
}
function nameFromEval5Value(v){
  const cat = (v >>> 20) & 0xF;
  if (cat === 8){
    const packed = v & ((1<<20)-1);
    const hi = getStraightHighFromPacked(packed);
    if (hi === 14) return 'Royal Flush';
    return 'Straight Flush';
  }
  return CAT_DE[cat] || '—';
}
function currentHandName(hero2, boardKnown){
  const cards = [...hero2, ...boardKnown].filter(x => x !== null && x !== undefined);
  if (cards.length < 2) return '—';
  if (cards.length < 5){
    if (cards.length === 2 && ID_RANK[cards[0]] === ID_RANK[cards[1]]) return 'Ein Paar (Pocket Pair)';
    return 'Hohe Karte';
  }
  const n = cards.length;
  let best = -1;
  for (let a=0;a<n-4;a++)
  for (let b=a+1;b<n-3;b++)
  for (let c=b+1;c<n-2;c++)
  for (let d=c+1;d<n-1;d++)
  for (let e=d+1;e<n;e++){
    const v = eval5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
    if (v > best) best = v;
  }
  return nameFromEval5Value(best);
}

/* =========================
   Decision Score System (unchanged)
========================= */
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function tanh(x){ return Math.tanh ? Math.tanh(x) : ((Math.exp(2*x)-1)/(Math.exp(2*x)+1)); }

function chenHighPoints(rank){
  if (rank === 14) return 10;
  if (rank === 13) return 8;
  if (rank === 12) return 7;
  if (rank === 11) return 6;
  return rank / 2;
}
function chenValue(hero2){
  const r1 = ID_RANK[hero2[0]];
  const r2 = ID_RANK[hero2[1]];
  const s1 = ID_SUIT[hero2[0]];
  const s2 = ID_SUIT[hero2[1]];
  const suited = (s1 === s2);

  const hi = Math.max(r1,r2);
  const lo = Math.min(r1,r2);
  const isPair = (hi === lo);

  let score = chenHighPoints(hi);

  if (isPair){
    score *= 2;
    score = Math.max(score, 5);
    return Math.ceil(score);
  }

  if (suited) score += 2;

  const gap = hi - lo - 1;
  if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;

  if (hi <= 12 && gap <= 1) score += 1;

  return Math.ceil(score);
}

function preflopDecisionScore(hero2, opponents){
  const chen = chenValue(hero2);
  const chenNorm = clamp(chen / 20, 0, 1);

  let score = 100 * Math.pow(chenNorm, 0.78);

  const tightness = clamp(1 - 0.04 * (opponents - 1), 0.68, 1);
  score = 50 + (score - 50) * tightness;

  return { score: clamp(score, 0, 100), chen };
}

function decisionScoreFromEquity({equity, opponents, pot, call, half95}){
  const hasPot = Number.isFinite(pot) && pot >= 0;
  const hasCall = Number.isFinite(call) && call >= 0;
  const hasOdds = hasPot && hasCall && (pot + call) > 0 && call > 0;

  let basisText;
  let score;

  if (hasOdds){
    const required = call / (pot + call);
    const edge = equity - required;
    basisText = `Pot Odds: benötigt ${(required*100).toFixed(1)}% · Edge ${(edge*100).toFixed(1)}%`;
    score = 50 + 50 * tanh(edge / 0.08);
  } else {
    const baseline = 1 / (opponents + 1);
    const edge = equity - baseline;
    basisText = `Baseline ${(baseline*100).toFixed(1)}% · Vorteil ${(edge*100).toFixed(1)}%`;
    score = 50 + 50 * tanh(edge / 0.12);
  }

  score -= Math.max(0, opponents - 1) * 1.2;

  if (Number.isFinite(half95)){
    score -= clamp(half95 * 100 * 0.22, 0, 7);
  }

  return { score: clamp(score, 0, 100), basisText };
}

function actionFromScore(score, stage){
  const t = (stage === 'pre')
    ? {raise:76, play:54, meh:46}
    : {raise:72, play:58, meh:48};

  if (score >= t.raise) return {label:'RAISE / VALUE', tag:'good'};
  if (score >= t.play)  return {label:'SPIELBAR', tag:'good'};
  if (score >= t.meh)   return {label:'GRENZBEREICH', tag:'warn'};
  return {label:'EHER FOLD', tag:'bad'};
}

/* =========================
   UI + App State
========================= */
const deckLeftEl = document.getElementById('deckLeft');
const errEl = document.getElementById('err');

const heroSlotsEl = document.getElementById('heroSlots');
const boardSlotsEl = document.getElementById('boardSlots');
const boardAreaEl = document.getElementById('boardArea');

const targetHint = document.getElementById('targetHint');
const targetChipValEl = document.getElementById('targetChipVal');

const previewCardEl = document.getElementById('previewCard');
const previewEl = document.getElementById('preview');

const undoBtn = document.getElementById('undoBtn');
const resetBtn = document.getElementById('resetBtn');
const calcBtn = document.getElementById('calcBtn');
const cancelBtn = document.getElementById('cancelBtn');
const commitBtn = document.getElementById('commit');
const clearSlotBtn = document.getElementById('clearSlotBtn');

const statusText = document.getElementById('statusText');
const barFill = document.getElementById('barFill');

const resultEl = document.getElementById('result');
const equityEl = document.getElementById('equity');
const equityMetaEl = document.getElementById('equityMeta');
const handNowEl = document.getElementById('handNow');
const wtlEl = document.getElementById('wtl');
const ciEl = document.getElementById('ci');
const adviceEl = document.getElementById('advice');
const adviceDetailEl = document.getElementById('adviceDetail');
const detailsEl = document.getElementById('details');
const details2El = document.getElementById('details2');
const modeHintEl = document.getElementById('modeHint');

const decisionScoreEl = document.getElementById('decisionScore');
const decisionLabelEl = document.getElementById('decisionLabel');
const decisionWhyEl   = document.getElementById('decisionWhy');

const oppEl = document.getElementById('opp');
const oppValEl = document.getElementById('oppVal');
const itersEl = document.getElementById('iters');
const itersValEl = document.getElementById('itersVal');
const calcModeEl = document.getElementById('calcMode');
const potEl = document.getElementById('pot');
const callEl = document.getElementById('call');

const ctaHintEl = document.getElementById('ctaHint');
const resultsPanel = document.getElementById('resultsPanel');

/* Wheel elements */
const rankWheelEl = document.getElementById('rankWheel');
const suitWheelEl = document.getElementById('suitWheel');

let stage = 'pre';
let hero = [null, null];
let board = [null, null, null, null, null];
let selected = {type:'hero', index:0};
const history = [];

/* Wheel state (indices) */
let rankIdx = 12; // A
let suitIdx = 0;  // ♠

/* cancellation token */
let activeRunId = 0;
let cancelRequested = false;

function fmtPct(x,d=2){ return (x*100).toFixed(d) + ' %'; }
function setStatus(text,p){
  statusText.textContent = text;
  barFill.style.width = (p*100).toFixed(1)+'%';
}
function showErr(msg){
  errEl.style.display = 'block';
  errEl.textContent = msg;
  if (navigator.vibrate) navigator.vibrate(25);
}
function clearErr(){
  errEl.style.display = 'none';
  errEl.textContent = '';
}

function boardMax(){
  if (stage==='pre') return 0;
  if (stage==='flop') return 3;
  if (stage==='turn') return 4;
  return 5;
}
function boardVisibleArray(){ return board.slice(0, boardMax()); }
function usedSet(){
  const s = new Set();
  for (const x of hero) if (x!==null) s.add(x);
  for (const x of boardVisibleArray()) if (x!==null) s.add(x);
  return s;
}
function deckLeft(){ return 52 - usedSet().size; }

function slotTitle(t,i){
  if (t==='hero') return (i===0 ? 'Hole 1' : 'Hole 2');
  return 'Board ' + (i+1);
}
function nextEmptySlot(){
  for (let i=0;i<2;i++) if (hero[i]===null) return {type:'hero', index:i};
  const max = boardMax();
  for (let i=0;i<max;i++) if (board[i]===null) return {type:'board', index:i};
  return null;
}
function setSelected(t,i, pulse=true){
  selected = {type:t, index:i};
  const title = slotTitle(t,i);
  targetHint.textContent = `Ziel: ${title}`;
  targetChipValEl.textContent = title;
  renderSlots(pulse);
  saveStateDebounced();
}
function renderSlots(pulseSelected=false){
  heroSlotsEl.innerHTML = '';
  for (let i=0;i<2;i++){
    const el = document.createElement('div');
    const isSel = (selected.type==='hero' && selected.index===i);
    el.className = 'slot' + (isSel ? ' sel' : '') + (isSel && pulseSelected ? ' pulse' : '');
    el.dataset.type='hero'; el.dataset.index=String(i);
    el.innerHTML = (hero[i]===null) ? emptyHTML() : cardHTML(hero[i]);
    el.addEventListener('click', ()=>setSelected('hero', i, true));
    heroSlotsEl.appendChild(el);
  }

  const max = boardMax();
  boardSlotsEl.innerHTML = '';
  for (let i=0;i<max;i++){
    const el = document.createElement('div');
    const isSel = (selected.type==='board' && selected.index===i);
    el.className = 'slot' + (isSel ? ' sel' : '') + (isSel && pulseSelected ? ' pulse' : '');
    el.dataset.type='board'; el.dataset.index=String(i);
    el.innerHTML = (board[i]===null) ? emptyHTML() : cardHTML(board[i]);
    el.addEventListener('click', ()=>setSelected('board', i, true));
    boardSlotsEl.appendChild(el);
  }

  boardAreaEl.style.display = (max>0) ? '' : 'none';
  deckLeftEl.textContent = String(deckLeft());

  const opp = Number(oppEl.value);
  const knownBoard = getBoardKnown();
  const exactEligible = (opp===1 && knownBoard.length>=3);
  modeHintEl.textContent = exactEligible
    ? 'Exakt möglich (Heads-Up ab Flop) – sonst Monte-Carlo'
    : 'Monte-Carlo (Exakt nur Heads-Up ab Flop)';

  updateCalcEnabled();
}
function getHero(){
  if (hero[0]===null || hero[1]===null) return null;
  return [hero[0], hero[1]];
}
function getBoardKnown(){
  const max = boardMax();
  const arr = [];
  for (let i=0;i<max;i++){
    if (board[i]!==null) arr.push(board[i]);
  }
  return arr.slice(0,5);
}

function validateForCalcLite(){
  const h = getHero();
  if (!h) return {ok:false, msg:'Setze beide Hole Cards.'};
  const max = boardMax();
  if (max>0){
    for (let i=0;i<max;i++){
      if (board[i]===null) return {ok:false, msg:`Setze Board ${i+1} (${stage.toUpperCase()}).`};
    }
  }
  return {ok:true, msg:'Bereit zum Berechnen.'};
}
function updateCalcEnabled(){
  const v = validateForCalcLite();
  calcBtn.disabled = !v.ok || isBusy();
  ctaHintEl.textContent = v.msg;
}
function isBusy(){
  return cancelBtn.style.display !== 'none';
}

/* ===== Range progress helper ===== */
function setRangeProgress(el){
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const val = Number(el.value || 0);
  const p = (max === min) ? 0 : ((val - min) / (max - min)) * 100;
  el.style.setProperty('--p', String(Math.max(0, Math.min(100, p))));
}
function wireRange(el){
  setRangeProgress(el);
  el.addEventListener('input', ()=>{
    setRangeProgress(el);
    saveStateDebounced();
  });
}

/* ===== Stage switching ===== */
function applyStage(newStage, {fromInit=false} = {}){
  stage = newStage;

  document.querySelectorAll('.stageBtn').forEach(b=>{
    b.classList.toggle('active', b.dataset.stage === stage);
  });

  const max = boardMax();
  for (let i=max;i<5;i++) board[i]=null;

  for (let i=history.length-1;i>=0;i--){
    const h = history[i];
    if (h.type==='board' && (stage==='pre' || h.index>=max)) history.splice(i,1);
  }
  undoBtn.disabled = (history.length===0);

  const n = nextEmptySlot() || {type:'hero', index:1};
  setSelected(n.type, n.index, true);

  clearErr();
  resultEl.style.display = 'none';
  renderSlots(true);
  updateCalcEnabled();

  if (!fromInit) saveStateDebounced();
}
document.querySelectorAll('.stageBtn').forEach(b=>{
  b.addEventListener('click', ()=>applyStage(b.dataset.stage));
});

/* Opponents slider */
oppEl.addEventListener('input', ()=>{
  oppValEl.textContent = oppEl.value;
  renderSlots(false);
  saveStateDebounced();
});

/* =========================
   Wheel Picker
========================= */
function cssVarNumber(name, fallback){
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = Number(v.replace('px',''));
  return Number.isFinite(n) ? n : fallback;
}
function buildWheel(el, items, {renderItem} = {}){
  el.innerHTML = '';
  const spacerTop = document.createElement('div');
  spacerTop.className = 'wheelSpacer';
  el.appendChild(spacerTop);

  items.forEach((it, idx)=>{
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wheelItem';
    btn.dataset.index = String(idx);
    btn.innerHTML = renderItem ? renderItem(it, idx) : String(it);
    btn.addEventListener('click', ()=>{
      scrollWheelToIndex(el, idx, true);
    });
    el.appendChild(btn);
  });

  const spacerBot = document.createElement('div');
  spacerBot.className = 'wheelSpacer';
  el.appendChild(spacerBot);
}

function wheelItemEls(el){
  return Array.from(el.querySelectorAll('.wheelItem'));
}

function scrollWheelToIndex(wheelEl, idx, smooth){
  const itemH = cssVarNumber('--wheelItemH', 56);
  wheelEl.scrollTo({ top: idx * itemH, behavior: smooth ? 'smooth' : 'auto' });
}

function wheelIndexFromScroll(wheelEl){
  const itemH = cssVarNumber('--wheelItemH', 56);
  return Math.round(wheelEl.scrollTop / itemH);
}

let _wheelRAF = 0;
function wireWheel(wheelEl, onIndex){
  const handler = ()=>{
    if (_wheelRAF) return;
    _wheelRAF = requestAnimationFrame(()=>{
      _wheelRAF = 0;
      onIndex(wheelIndexFromScroll(wheelEl));
    });
  };
  wheelEl.addEventListener('scroll', handler, {passive:true});
}

function setActiveWheelItem(wheelEl, idx){
  const items = wheelItemEls(wheelEl);
  items.forEach((b, i)=>b.classList.toggle('active', i === idx));
}

function setSuitTheme(si){
  const map = [
    { a:'rgba(160,190,255,.22)', b:'rgba(92,142,255,.12)', glow:'rgba(160,190,255,.18)' }, // ♠
    { a:'rgba(255,92,126,.22)',  b:'rgba(255,70,102,.12)', glow:'rgba(255,92,126,.18)' }, // ♥
    { a:'rgba(255,200,88,.22)',  b:'rgba(255,145,58,.12)', glow:'rgba(255,200,88,.18)' }, // ♦
    { a:'rgba(82,240,182,.18)',  b:'rgba(34,198,148,.10)', glow:'rgba(82,240,182,.16)' }, // ♣
  ];
  const c = map[si] || map[0];
  document.documentElement.style.setProperty('--suitA', c.a);
  document.documentElement.style.setProperty('--suitB', c.b);
  document.documentElement.style.setProperty('--suitGlow', c.glow);
}

function getCardIdFromPicker(){
  return CODE_TO_ID[RANKS[rankIdx] + SUITS[suitIdx].c];
}

function updatePreview(){
  const id = getCardIdFromPicker();
  previewCardEl.innerHTML = cardHTML(id);

  setSuitTheme(suitIdx);

  previewEl.classList.add('bump');
  clearTimeout(updatePreview._t);
  updatePreview._t = setTimeout(()=>previewEl.classList.remove('bump'), 120);

  saveStateDebounced();
}

/* =========================
   Animation for commit
========================= */
async function animateToSlot(cardId, slotEl){
  const start = previewEl.getBoundingClientRect();
  const end = slotEl.getBoundingClientRect();

  const float = document.createElement('div');
  float.className = 'floatCard';
  float.style.left = start.left + 'px';
  float.style.top = start.top + 'px';
  float.style.width = start.width + 'px';
  float.style.height = start.height + 'px';
  float.innerHTML = `<div style="transform:scale(.9); display:flex; align-items:center; justify-content:center; width:100%; height:100%;">${cardHTML(cardId)}</div>`;
  document.body.appendChild(float);

  const dx = (end.left + end.width/2) - (start.left + start.width/2);
  const dy = (end.top + end.height/2) - (start.top + start.height/2);
  const scale = Math.min(1.0, end.width / start.width);

  await float.animate([
    { transform: 'translate(0px,0px) scale(1)', opacity: 1, filter:'blur(0px)' },
    { transform: `translate(${dx}px,${dy}px) scale(${scale})`, opacity: 0.15, filter:'blur(0.6px)' }
  ], { duration: 430, easing: 'cubic-bezier(.2,.9,.2,1)' }).finished;

  float.remove();

  slotEl.animate(
    [{transform:'scale(1)'},{transform:'scale(1.05)'},{transform:'scale(1)'}],
    {duration: 240, easing:'cubic-bezier(.2,.9,.2,1)'}
  );
}

function slotValue(t,i){ return (t==='hero') ? hero[i] : board[i]; }
function setSlotValue(t,i,val){ if (t==='hero') hero[i]=val; else board[i]=val; }

/* Commit card */
async function commitSelectedCard(){
  clearErr();

  let target = selected;
  if (stage==='pre' && target.type==='board'){
    target = nextEmptySlot() || {type:'hero', index:1};
    setSelected(target.type, target.index, true);
  }
  if (target.type==='board' && target.index >= boardMax()){
    const n = nextEmptySlot();
    if (!n){
      showErr('Alle Slots belegt. Slot antippen zum Ersetzen oder Reset.');
      return;
    }
    target = n; setSelected(n.type, n.index, true);
  }

  const id = getCardIdFromPicker();
  const used = usedSet();
  const prev = slotValue(target.type, target.index);
  if (prev!==null) used.delete(prev);

  if (used.has(id)){
    showErr('Diese Karte ist bereits vergeben. Bitte wähle eine andere.');
    return;
  }

  const slotEl = Array.from(document.querySelectorAll('.slot')).find(el =>
    el.dataset.type===target.type && Number(el.dataset.index)===target.index
  );
  if (!slotEl){
    showErr('UI-Fehler: Zielslot nicht gefunden.');
    return;
  }

  await animateToSlot(id, slotEl);

  setSlotValue(target.type, target.index, id);

  history.push({type:target.type, index:target.index, prev, next:id});
  undoBtn.disabled = (history.length===0);

  const n = nextEmptySlot();
  if (n) setSelected(n.type, n.index, true);
  else renderSlots(false);

  resultEl.style.display = 'none';
  updateCalcEnabled();
  saveStateDebounced();
}

commitBtn.addEventListener('click', commitSelectedCard);
previewEl.addEventListener('click', commitSelectedCard);

clearSlotBtn.addEventListener('click', ()=>{
  clearErr();
  const prev = slotValue(selected.type, selected.index);
  if (prev === null){
    showErr('Slot ist bereits leer.');
    return;
  }
  setSlotValue(selected.type, selected.index, null);
  history.push({type:selected.type, index:selected.index, prev, next:null});
  undoBtn.disabled = (history.length===0);
  renderSlots(true);
  resultEl.style.display = 'none';
  updateCalcEnabled();
  saveStateDebounced();
});

/* Undo / Reset */
undoBtn.addEventListener('click', ()=>{
  clearErr();
  const h = history.pop();
  if (!h) return;
  setSlotValue(h.type, h.index, h.prev);
  undoBtn.disabled = (history.length===0);
  setSelected(h.type, h.index, true);
  renderSlots(true);
  resultEl.style.display = 'none';
  updateCalcEnabled();
  saveStateDebounced();
});
resetBtn.addEventListener('click', ()=>{
  clearErr();
  hero = [null,null];
  board = [null,null,null,null,null];
  history.length = 0;
  undoBtn.disabled = true;
  resultEl.style.display = 'none';
  setStatus('Bereit.', 0);
  setSelected('hero', 0, true);
  renderSlots(true);
  updateCalcEnabled();
  saveStateDebounced();
});

/* Advanced */
itersEl.addEventListener('input', ()=>{ itersValEl.textContent = itersEl.value; saveStateDebounced(); });
calcModeEl.addEventListener('change', saveStateDebounced);
potEl.addEventListener('input', saveStateDebounced);
callEl.addEventListener('input', saveStateDebounced);

/* Cancel handling */
function beginRun(){
  cancelRequested = false;
  cancelBtn.style.display = '';
  cancelBtn.disabled = false;
  return ++activeRunId;
}
function endRun(){
  cancelBtn.style.display = 'none';
  cancelBtn.disabled = true;
  cancelRequested = false;
}
function shouldCancel(runId){
  return cancelRequested || runId !== activeRunId;
}
cancelBtn.addEventListener('click', ()=>{
  cancelRequested = true;
  cancelBtn.disabled = true;
  setStatus('Abbrechen…', barFill.style.width ? parseFloat(barFill.style.width)/100 : 0);
});

/* Calc validation */
function validateForCalc(){
  const v = validateForCalcLite();
  if (!v.ok){
    showErr(v.msg);
    return false;
  }
  const pot = (potEl.value==='') ? NaN : Number(potEl.value);
  const call = (callEl.value==='') ? NaN : Number(callEl.value);
  if (Number.isFinite(pot) && pot < 0) { showErr('Pot darf nicht negativ sein.'); return false; }
  if (Number.isFinite(call) && call < 0) { showErr('Call darf nicht negativ sein.'); return false; }
  return true;
}

calcBtn.addEventListener('click', async ()=>{
  clearErr();
  if (!validateForCalc()) return;

  const runId = beginRun();

  const opponents = Number(oppEl.value);
  const maxIters = Number(itersEl.value);
  const selectedMode = calcModeEl.value;

  const h = getHero();
  const boardKnown = getBoardKnown();

  const exactEligible = (opponents===1 && boardKnown.length>=3);
  let mode = 'mc';
  if (selectedMode==='exact') mode='exact';
  else if (selectedMode==='mc') mode='mc';
  else mode = exactEligible ? 'exact' : 'mc';

  if (mode==='exact' && !exactEligible){
    showErr('Exakt ist nur möglich bei Heads-Up (1 Gegner) und mindestens Flop (3 Boardkarten).');
    endRun();
    updateCalcEnabled();
    return;
  }

  calcBtn.disabled = true;
  resetBtn.disabled = true;
  undoBtn.disabled = true;
  commitBtn.disabled = true;
  clearSlotBtn.disabled = true;

  setStatus('Rechnet…', 0.06);
  resultEl.style.display = 'none';

  try{
    let equity, winProb, tieProb, loseProb, ciText, details2;
    let mcHalf95 = NaN;

    if (mode === 'exact'){
      setStatus('Exakt (Heads-Up)…', 0.10);
      const res = await exactHeadsUpFromFlop(
        h, boardKnown,
        (p)=>setStatus('Exakt (Heads-Up)…', p),
        ()=>shouldCancel(runId)
      );
      equity = res.equity;
      winProb = res.winProb; tieProb = res.tieProb; loseProb = res.loseProb;
      ciText = `Exakt berechnet (States: ${res.states.toLocaleString('de-DE')}).`;
      details2 = `${stage.toUpperCase()} · Gegnerhände: zufällig · exakt`;
      setStatus('Fertig (exakt).', 1);
    } else {
      const targetHalf = (stage === 'pre') ? 0.012 : 0.010;
      const minIters = (stage === 'pre') ? 30000 : 20000;

      setStatus('Monte-Carlo…', 0.10);
      const res = await monteCarloEquityAdaptive(
        h, boardKnown, opponents,
        { minIters: Math.min(minIters, maxIters), maxIters, targetHalfWidth95: targetHalf },
        (p)=>setStatus('Monte-Carlo…', p),
        ()=>shouldCancel(runId)
      );

      equity = res.equity;
      winProb = res.winProb; tieProb = res.tieProb; loseProb = res.loseProb;
      mcHalf95 = res.half95;

      const half = res.half95 ?? (1.96*res.se);
      ciText = `≈ 95% CI: ${fmtPct(Math.max(0, equity-half),2)} bis ${fmtPct(Math.min(1, equity+half),2)} · Iter: ${res.iters.toLocaleString('de-DE')}`;
      details2 = `${stage.toUpperCase()} · Gegnerhände: zufällig · MC (adaptiv)`;
      setStatus('Fertig (MC).', 1);
    }

    if (shouldCancel(runId)) throw new Error('CANCELLED');

    const eqScore = Math.max(1, Math.min(100, Math.round(equity*100)));
    equityEl.textContent = fmtPct(equity,2);
    equityMetaEl.textContent = `Score: ${eqScore} / 100`;

    const nowHand = currentHandName(h, boardKnown);
    handNowEl.textContent = `Aktuelle Kombination: ${nowHand}`;

    wtlEl.textContent = `W/T/L: ${fmtPct(winProb,1)} / ${fmtPct(tieProb,1)} / ${fmtPct(loseProb,1)}`;
    ciEl.textContent = ciText;

    const pot = (potEl.value==='') ? NaN : Number(potEl.value);
    const call = (callEl.value==='') ? NaN : Number(callEl.value);

    let decScore, why;
    if (stage === 'pre'){
      const out = preflopDecisionScore(h, opponents);
      decScore = out.score;
      why = `Preflop (Chen: ${out.chen}/20) · angepasst für ${opponents} Gegner`;
    } else {
      const out = decisionScoreFromEquity({ equity, opponents, pot, call, half95: (mode==='mc' ? mcHalf95 : NaN) });
      decScore = out.score;
      why = out.basisText;
    }

    const act = actionFromScore(decScore, stage);

    decisionScoreEl.textContent = `${Math.round(decScore)}/100`;
    decisionLabelEl.innerHTML = `<span class="tag ${act.tag}">${act.label}</span>`;
    decisionWhyEl.textContent = why;

    adviceEl.innerHTML = `${act.label} <span class="tag ${act.tag}">${act.tag.toUpperCase()}</span>`;

    if (stage === 'pre'){
      adviceDetailEl.textContent =
        decScore >= 54
          ? 'Preflop solide – tendenziell spielen (Position/Action beachten).'
          : (decScore >= 46
              ? 'Grenzbereich – eher nur in günstigen Spots.'
              : 'Eher fold – außer spezielle Reads/Situation.');
    } else {
      const hasOdds = Number.isFinite(pot) && Number.isFinite(call) && call>0 && (pot+call)>0;
      adviceDetailEl.textContent = hasOdds
        ? 'Postflop: Pot Odds/Edge + Equity (multiway konservativ).'
        : 'Postflop: Equity-Vorteil vs. Multiway-Baseline.';
    }

    const modeTxt = (mode==='exact') ? 'Exakt' : `Monte-Carlo (Max ${maxIters.toLocaleString('de-DE')})`;
    detailsEl.textContent = `${modeTxt} · Gegner: ${opponents}`;
    details2El.textContent = details2;

    resultEl.style.display = 'grid';
    resultsPanel.scrollIntoView({behavior:'smooth', block:'start'});
  } catch(e){
    if (e && e.message === 'CANCELLED'){
      showErr('Berechnung abgebrochen.');
      setStatus('Abgebrochen.', 0);
    } else {
      showErr('Fehler bei der Berechnung: ' + (e && e.message ? e.message : String(e)));
    }
  } finally {
    endRun();
    calcBtn.disabled = !validateForCalcLite().ok;
    resetBtn.disabled = false;
    undoBtn.disabled = (history.length===0);
    commitBtn.disabled = false;
    clearSlotBtn.disabled = false;
    updateCalcEnabled();
  }
});

/* =========================
   Modal open/close logic
========================= */
const handsBtn = document.getElementById('handsBtn');
const handsModal = document.getElementById('handsModal');
const handsClose = document.getElementById('handsClose');
let lastFocusEl = null;

function openHands(){
  lastFocusEl = document.activeElement;
  handsModal.style.display = 'flex';
  requestAnimationFrame(()=>handsModal.classList.add('show'));
  const modalBox = handsModal.querySelector('.modal');
  modalBox.focus();
  document.body.style.overflow = 'hidden';
}
function closeHands(){
  handsModal.classList.remove('show');
  setTimeout(()=>{
    handsModal.style.display = 'none';
    document.body.style.overflow = '';
    if (lastFocusEl && typeof lastFocusEl.focus === 'function') lastFocusEl.focus();
  }, 180);
}
handsBtn.addEventListener('click', openHands);
handsClose.addEventListener('click', closeHands);
handsModal.addEventListener('click', (e)=>{ if (e.target === handsModal) closeHands(); });
document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && handsModal.style.display === 'flex') closeHands(); });

/* =========================
   Init
========================= */
function initWheel(){
  buildWheel(rankWheelEl, RANKS, { renderItem: (r)=> (r === 'T' ? '10' : r) });
  buildWheel(suitWheelEl, SUITS, {
    renderItem: (s)=> `<span class="${s.red ? 'suit-red' : 'suit-white'}" style="font-size:20px;">${s.sym}</span>`
  });

  wireWheel(rankWheelEl, (idx)=>{
    const clamped = clamp(idx, 0, 12);
    if (clamped !== rankIdx){
      rankIdx = clamped;
      setActiveWheelItem(rankWheelEl, rankIdx);
      updatePreview();
    }
  });

  wireWheel(suitWheelEl, (idx)=>{
    const clamped = clamp(idx, 0, 3);
    if (clamped !== suitIdx){
      suitIdx = clamped;
      setActiveWheelItem(suitWheelEl, suitIdx);
      updatePreview();
    }
  });
}

function init(){
  wireRange(oppEl);
  wireRange(itersEl);

  const st = loadState();
  if (st){
    if (st.opp) { oppEl.value = String(clamp(Number(st.opp),1,8)); }
    if (st.iters) { itersEl.value = String(clamp(Number(st.iters),10000,250000)); }
    if (typeof st.calcMode === 'string') calcModeEl.value = st.calcMode;
    if (typeof st.pot === 'string') potEl.value = st.pot;
    if (typeof st.call === 'string') callEl.value = st.call;
    if (Number.isFinite(st.rankIdx)) rankIdx = clamp(Number(st.rankIdx), 0, 12);
    if (Number.isFinite(st.suitIdx)) suitIdx = clamp(Number(st.suitIdx), 0, 3);
    if (typeof st.stage === 'string' && ['pre','flop','turn','river'].includes(st.stage)) stage = st.stage;
  }

  oppValEl.textContent = oppEl.value;
  itersValEl.textContent = itersEl.value;
  undoBtn.disabled = true;

  initWheel();

  requestAnimationFrame(()=>{
    scrollWheelToIndex(rankWheelEl, rankIdx, false);
    scrollWheelToIndex(suitWheelEl, suitIdx, false);
    setActiveWheelItem(rankWheelEl, rankIdx);
    setActiveWheelItem(suitWheelEl, suitIdx);
    updatePreview();
  });

  applyStage(stage, {fromInit:true});
  setStatus('Bereit.', 0);
  renderSlots(true);
  updateCalcEnabled();

  setSelected('hero', 0, true);
  saveStateDebounced();
}
init();
