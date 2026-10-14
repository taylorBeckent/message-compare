const fs=require('fs'), babel=require('@babel/core');
const origJs=require.extensions['.js'];
require.extensions['.js']=function(m,f){ if(f.indexOf('/src/')>-1){ const o=babel.transformSync(fs.readFileSync(f,'utf8'),{filename:f,presets:[['@babel/preset-env',{targets:{node:'12'},modules:'commonjs'}]],configFile:false,babelrc:false}); m._compile(o.code,f);} else return origJs(m,f); };
const S=__dirname+'/src';
const ds=require(S+'/mock/dataset.js'), de=require(S+'/core/diffEngine.js');

let bad=0, checked=0;
['pay-clearing','order-sync','recon-file','regression','stress'].forEach(gid=>{
  const g=ds.getGroup(gid); const dist={};
  g.records.forEach(r=>{
    const d=de.computeDiff(r.left_text,r.right_text), s=d.stats;
    dist[r.mutation]=(dist[r.mutation]||0)+1;
    checked++;
    const okA = s.context + s.removed === s.leftLines;
    const okB = s.context + s.added === s.rightLines;
    const okC = d.rows.length === s.leftLines + s.rightLines - s.context;
    const okD = d.spark.length === d.rows.length;
    const okE = s.severity>=0 && s.severity<=1;
    if(!(okA&&okB&&okC&&okD&&okE)){ bad++; if(bad<=3) console.log('FAIL',gid,r.seq,{okA,okB,okC,okD,okE},JSON.stringify(s)); }
  });
  console.log(gid.padEnd(14), 'n='+g.records.length, JSON.stringify(dist));
});
console.log('\ninvariants checked:', checked, 'failures:', bad);

const g=ds.getGroup('pay-clearing');
const vr=g.records.filter(r=>r.mutation==='value')[0];
const dd=de.computeDiff(vr.left_text, vr.right_text);
console.log('\n--- value mutation: non-ctx rows ---');
dd.rows.filter(r=>r.t!=='c').forEach(r=>console.log(' ',r.t,'L'+r.l,'R'+r.r,'|',JSON.stringify(r.s).slice(0,60), r.g?('HL='+JSON.stringify(r.g.filter(x=>x[1]).map(x=>x[0]))):''));
console.log('stats:',JSON.stringify(dd.stats));

const ro=g.records.filter(r=>r.mutation==='reorder')[0];
const dr=de.computeDiff(ro.left_text, ro.right_text);
console.log('\nreorder severity:', dr.stats.severity.toFixed(3), 'added',dr.stats.added,'removed',dr.stats.removed);

const mj=g.records.filter(r=>r.mutation==='major')[0];
console.log('major severity:', de.computeDiff(mj.left_text,mj.right_text).stats.severity.toFixed(3));
const rc=ds.getGroup('recon-file').records.filter(r=>r.mutation==='value')[0];
const drc=de.computeDiff(rc.left_text,rc.right_text);
console.log('recon value: lines',drc.stats.leftLines,'severity',drc.stats.severity.toFixed(3),'changed',drc.stats.changed);
