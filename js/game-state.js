import { LearningLab } from './learning.js';

export const FAMILIES = {
  add: { label: 'Addition', symbol: '+', unlock: 0 },
  sub: { label: 'Soustraction', symbol: '−', unlock: 3 },
  mul: { label: 'Multiplication', symbol: '×', unlock: 4 },
  div: { label: 'Division', symbol: '÷', unlock: 5 }
};
export const CHAPTERS = [
  { family: 'add', curriculum: 'first', min: 12, accuracy: 1, tolerance: .35, reward: 30 },
  { family: 'add', curriculum: 'small', min: 250, accuracy: .8, tolerance: .5, reward: 100 },
  { family: 'add', curriculum: 'full', min: 800, accuracy: .9, tolerance: .5, reward: 300 },
  { family: 'sub', curriculum: 'full', min: 800, accuracy: .9, tolerance: .5, reward: 650 },
  { family: 'mul', curriculum: 'full', min: 2400, accuracy: .97, tolerance: .5, reward: 1500 },
  { family: 'div', curriculum: 'full', min: 4000, accuracy: .9, tolerance: .15, reward: 3000 },
  { family: 'div', curriculum: 'full', min: 0, accuracy: 0, tolerance: .15, reward: 0 }
];
export const UPGRADES = [
  { id: 'batch', minExamples: 8, minPhase: 0, prices: [16,55,180,580,1800,5000] },
  { id: 'auto', minExamples: 12, minPhase: 0, prices: [30,100,300,900,2600,7400,18000,50000] },
  { id: 'focus', minExamples: 0, minPhase: 2, prices: [600] }
];
export const AUTO_RATES = [0,1,3,8,18,40,90,180,360];

function defaultData() {
  return { phase: 0, family: 'add', balance: 0, earned: 0, spent: 0, manualClicks: 0,
    upgrades: { batch: 0, auto: 0, focus: 0 }, autoEnabled: true, selected: null,
    preferences: { sound: false, reducedMotion: false }, histories: {}, focusCursor: 0 };
}

export class GameSession {
  constructor() { this.lab = new LearningLab(); this.data = defaultData(); this.metrics = null; this.weakCases = []; this.refreshMetrics(); }
  get chapter() { return CHAPTERS[this.data.phase]; }
  get total() { return Object.keys(FAMILIES).reduce((n, type) => n + this.lab.getNetwork(type).trained, 0); }
  get revisions() { return Object.keys(FAMILIES).reduce((n, type) => n + this.lab.getNetwork(type).revisions, 0); }
  get clickPower() { return 2 ** this.data.upgrades.batch; }
  get autoRate() { return this.data.autoEnabled ? AUTO_RATES[this.data.upgrades.auto] : 0; }
  get unlocked() { return Object.keys(FAMILIES).filter(type => FAMILIES[type].unlock <= this.data.phase); }
  get curriculum() { return this.data.family === 'add' && this.data.phase < 2 ? this.chapter.curriculum : 'full'; }
  get scopeKey() { return `${this.data.family}:${this.curriculum}`; }
  get trained() { return this.lab.getNetwork(this.data.family).trained; }
  get selectedExample() { return this.data.selected || { a: 2, b: 3 }; }
  selectFamily(type) {
    if (!this.unlocked.includes(type)) return false;
    this.data.family = type; this.data.selected = null; this.refreshMetrics(); return true;
  }
  selectExample(a,b) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || a > 9 || b < 0 || b > 9 || (this.data.family === 'div' && b === 0)) return false;
    if (this.data.phase === 0 && (a !== 2 || b !== 3)) return false;
    if (this.curriculum === 'small' && (a > 4 || b > 4)) return false;
    this.data.selected = { a, b }; return true;
  }
  target(type,a,b) { return type === 'add' ? a+b : type === 'sub' ? a-b : type === 'mul' ? a*b : a/b; }
  train(count, { manual = false } = {}) {
    count = Math.max(0, Math.min(500, Math.floor(count)));
    if (!count) return null;
    if (manual) this.data.manualClicks++;
    let last;
    for (let i=0;i<count;i++) {
      if (manual && this.data.selected) {
        const {a,b} = this.data.selected;
        last = this.lab.trainSample(this.data.family,a,b);
      } else if (this.data.upgrades.focus && this.weakCases.length && this.trained % 5 === 0) {
        const sample = this.weakCases[this.data.focusCursor++ % this.weakCases.length];
        last = this.lab.trainSample(this.data.family,sample.a,sample.b);
      } else last = this.lab.train(this.data.family,1,{curriculum:this.curriculum});
    }
    this.data.balance += count; this.data.earned += count;
    return { ...last, batchSize: count };
  }
  refreshMetrics() {
    const tolerance = this.data.phase === 0 ? .35 : (this.data.family === 'div' ? .15 : .5);
    this.metrics = this.lab.evaluate(this.data.family,{curriculum:this.curriculum,tolerance});
    const history = this.data.histories[this.scopeKey] ||= [];
    if (!history.length || history.at(-1).trained !== this.trained) history.push({ trained:this.trained,mae:this.metrics.mae });
    if (history.length > 60) history.splice(0,history.length-60);
    if (this.data.upgrades.focus) {
      const candidates=[];
      const max=this.curriculum==='small'?4:9;
      for(let a=0;a<=max;a++)for(let b=this.data.family==='div'?1:0;b<=max;b++) {
        candidates.push({a,b,error:Math.abs(this.lab.predict(this.data.family,a,b).value-this.target(this.data.family,a,b))});
      }
      this.weakCases=candidates.sort((a,b)=>b.error-a.error).slice(0,10);
    } else this.weakCases=[];
    return this.metrics;
  }
  checkMilestone() {
    if(this.data.phase>=6) return null;
    const chapter=this.chapter;
    const measured=this.data.family===chapter.family && this.curriculum===chapter.curriculum ? this.metrics : this.lab.evaluate(chapter.family,{curriculum:chapter.curriculum,tolerance:chapter.tolerance});
    const trained=this.lab.getNetwork(chapter.family).trained;
    if(trained < chapter.min || measured.accuracy + 1e-10 < chapter.accuracy) return null;
    const previous=this.data.phase;
    this.data.phase++; this.data.balance+=chapter.reward; this.data.earned+=chapter.reward;
    this.data.family=this.chapter.family; this.data.selected=null;
    this.refreshMetrics();
    return { previous, phase:this.data.phase, reward:chapter.reward, chapter:this.chapter };
  }
  milestoneProgress() {
    const chapter=this.chapter;
    if(this.data.phase>=6) return { ratio:1,trained:this.total,accuracy:this.metrics.accuracy };
    const measured=this.data.family===chapter.family && this.curriculum===chapter.curriculum?this.metrics:this.lab.evaluate(chapter.family,{curriculum:chapter.curriculum,tolerance:chapter.tolerance});
    const trained=this.lab.getNetwork(chapter.family).trained;
    return {ratio:Math.max(0,Math.min(1,trained/chapter.min,measured.accuracy/chapter.accuracy)),trained,accuracy:measured.accuracy};
  }
  purchase(id) {
    const upgrade=UPGRADES.find(item=>item.id===id);
    if(!upgrade) return false;
    const level=this.data.upgrades[id],price=upgrade.prices[level];
    if(price===undefined || this.total<upgrade.minExamples || this.data.phase<upgrade.minPhase || this.data.balance<price) return false;
    this.data.balance-=price; this.data.spent+=price; this.data.upgrades[id]++;
    if(id==='auto') this.data.autoEnabled=true;
    if(id==='focus') this.refreshMetrics();
    return true;
  }
  exportState() {
    // Synchronize adaptive replay before taking a snapshot. Restoring the same
    // weights must pick the same difficult cases as continuing this session.
    this.refreshMetrics();
    return { app:'fakir',version:3,savedAt:new Date().toISOString(),game:structuredClone(this.data),learning:this.lab.exportState() };
  }
  restore(payload) {
    if(typeof payload==='string')payload=JSON.parse(payload);
    if(!payload || payload.app!=='fakir' || payload.version!==3 || !payload.game || !payload.learning) throw new Error('Ce fichier n’est pas une progression Fakir compatible.');
    const data=payload.game;
    if(!Number.isInteger(data.phase)||data.phase<0||data.phase>6)throw new Error('Parcours invalide.');
    for(const key of ['balance','earned','spent','manualClicks','focusCursor'])if(!Number.isSafeInteger(data[key])||data[key]<0)throw new Error('Compteurs invalides.');
    if(data.earned-data.spent!==data.balance)throw new Error('Progression incohérente.');
    if(!Object.hasOwn(FAMILIES,data.family)||FAMILIES[data.family].unlock>data.phase)throw new Error('Opération non disponible.');
    for(const upgrade of UPGRADES)if(!Number.isInteger(data.upgrades?.[upgrade.id])||data.upgrades[upgrade.id]<0||data.upgrades[upgrade.id]>upgrade.prices.length)throw new Error('Améliorations invalides.');
    if(typeof data.autoEnabled!=='boolean'||typeof data.preferences?.sound!=='boolean'||typeof data.preferences?.reducedMotion!=='boolean')throw new Error('Réglages invalides.');
    const nextLab=LearningLab.fromState(payload.learning);
    const next=defaultData();
    for(const key of ['phase','family','balance','earned','spent','manualClicks','autoEnabled','focusCursor']) next[key]=data[key];
    next.upgrades={...data.upgrades};next.preferences={...data.preferences};
    if(data.histories && typeof data.histories==='object')for(const [key,list]of Object.entries(data.histories)) {
      if(!/^(add|sub|mul|div):(first|small|full)$/.test(key)||!Array.isArray(list))continue;
      next.histories[key]=list.slice(-60).filter(p=>p&&Number.isSafeInteger(p.trained)&&p.trained>=0&&Number.isFinite(p.mae)&&p.mae>=0).map(p=>({trained:p.trained,mae:p.mae}));
    }
    this.lab=nextLab;this.data=next;
    if(data.selected && Number.isInteger(data.selected.a)&&Number.isInteger(data.selected.b))this.selectExample(data.selected.a,data.selected.b);
    this.refreshMetrics();return this;
  }
}
