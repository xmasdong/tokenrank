// Threshold-based lookup also upgrades old share snapshots, whose art field names
// the family. Never trust a caller-supplied filename or tier number as an asset path.
const STAGES={
 requests:{art:'code-leaves',thresholds:[100,1000,10000,100000],original:3},
 models:{art:'neural-core',thresholds:[1,3,5,10],original:2},
 tools:{art:'linked-loops',thresholds:[2,3,5,8],original:1},
 active:{art:'steady-flame',thresholds:[3,7,30,100],original:2},
 uploads:{art:'upload-calendar',thresholds:[3,7,30,100],original:2},
 peak:{art:'milestone-peaks',thresholds:[1e8,5e8,1e9,5e9],original:3},
 total:{art:'usage-orbit',thresholds:[1e8,1e9,1e10,1e11],original:3},
};
function stageIndex(badge){const family=STAGES[badge?.family];return family?.art===badge?.art?family.thresholds.indexOf(badge.threshold)+1:0;}
function stageArt(badge){const family=STAGES[badge?.family],index=stageIndex(badge);return index&&index!==family.original?'/assets/badges/tiers/'+family.art+'-'+index+'.webp':'';}
module.exports={STAGES,stageIndex,stageArt};
