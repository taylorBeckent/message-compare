const fs=require('fs'), path=require('path'), babel=require('@babel/core'), Module=require('module');
const ROOT='/Users/kd/project/client/readyToDelete/msgCompare/msg-compare-studio/node_modules';
const origJs=require.extensions['.js'];
require.extensions['.js']=function(m,filename){
  if(filename.indexOf('/src/')>-1){
    const out=babel.transformSync(fs.readFileSync(filename,'utf8'),{filename,presets:[['@babel/preset-env',{targets:{node:'12'},modules:'commonjs'}]],configFile:false,babelrc:false});
    m._compile(out.code,filename);
  } else return origJs(m,filename);
};
module.paths.unshift(ROOT);
const S='/Users/kd/project/client/readyToDelete/msgCompare/msg-compare-studio/src';
const ds=require(S+'/mock/dataset.js');
const de=require(S+'/core/diffEngine.js');

const defs=ds.getGroupDefs();
console.log('groups:', defs.map(d=>d.id+'('+d.count+')').join(', '));

let t0=Date.now();
const g=ds.getGroup('pay-clearing');
console.log('gen pay-clearing:', g.records.length, 'records in', Date.now()-t0, 'ms');

// mutation distribution
const dist={};
g.records.forEach(r=>{dist[r.mutation]=(dist[r.mutation]||0)+1});
console.log('mutation dist:', JSON.stringify(dist));
console.log('--- sample left (first 12 lines) ---');
console.log(g.records[0].left_text.split('\n').slice(0,12).join('\n'));

t0=Date.now();
let sev={identical:0,changed:0,oneSided:0};
let sevSum=0;
g.records.forEach(r=>{
  const d=de.computeDiff(r.left_text,r.right_text);
  if(d.stats.identical) sev.identical++; else if(d.stats.oneSidedEmpty) sev.oneSided++; else sev.changed++;
  sevSum+=d.stats.severity;
});
console.log('diff 320 records in', Date.now()-t0,'ms ->', JSON.stringify(sev), 'avgSeverity=', (sevSum/g.records.length).toFixed(3));

// inspect one value-diff record's intra-line highlight
const vr=g.records.filter(r=>r.mutation==='value')[0];
const dd=de.computeDiff(vr.left_text, vr.right_text);
console.log('\n--- value mutation rows (non-ctx) ---');
dd.rows.filter(r=>r.t!=='c').slice(0,10).forEach(r=>{
  console.log(r.t, 'L'+r.l, 'R'+r.r, '|', JSON.stringify(r.s).slice(0,90), r.g?(' segs='+JSON.stringify(r.g.filter(x=>x[1]))):'');
});
console.log('stats:', JSON.stringify(dd.stats), 'spark.len=', dd.spark.length);

// hunk view
const hv=de.buildHunkView(dd.rows,3,false);
console.log('hunkView len', hv.length, 'of', dd.rows.length, 'gaps=', hv.filter(x=>x.t==='gap').length);

// big group perf
t0=Date.now(); const stress=ds.getGroup('stress');
console.log('\ngen stress(800):', Date.now()-t0,'ms');
t0=Date.now();
stress.records.forEach(r=>de.computeDiff(r.left_text,r.right_text));
console.log('diff 800 json records:', Date.now()-t0,'ms');
