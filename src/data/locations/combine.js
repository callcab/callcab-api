const fs = require('fs');
const path = require('path');

const TOWN_FILES = [
  'aspen.json', 'glenwood-springs.json', 'vail.json', 'snowmass.json',
  'basalt.json', 'carbondale.json', 'woody-creek.json', 'el-jebel.json',
  'avon.json', 'edwards.json', 'eagle.json', 'gypsum.json', 'rifle.json', 'silt.json'
];

function combineLocations() {
  console.log('🔄 Combining location files...\n');
  
  const allLocations = [];
  const townData = {};
  
  for (const filename of TOWN_FILES) {
    const filepath = path.join(__dirname, filename);
    if (!fs.existsSync(filepath)) {
      console.log(`⚠️  ${filename} not found, skipping...`);
      continue;
    }
    
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    console.log(`✓ ${data.town_display}: ${data.locations.length} locations`);
    
    townData[data.town] = {
      display_name: data.town_display,
      coordinates: data.coordinates,
      radius_miles: data.radius_miles
    };
    
    allLocations.push(...data.locations);
  }
  
  // Build indices
  const indices = {
    by_phonetic: {},
    by_misspelling: {},
    by_category: {},
    by_account: {}
  };
  
  for (const loc of allLocations) {
    // Phonetic
    for (const variant of loc.phonetic_variants || []) {
      const key = variant.toLowerCase();
      if (!indices.by_phonetic[key]) indices.by_phonetic[key] = [];
      indices.by_phonetic[key].push(loc.id);
    }
    
    // Misspelling
    for (const misspelling of loc.common_misspellings || []) {
      const key = misspelling.toLowerCase();
      if (!indices.by_misspelling[key]) indices.by_misspelling[key] = [];
      indices.by_misspelling[key].push(loc.id);
    }
    
    // Category
    if (loc.category) {
      if (!indices.by_category[loc.category]) indices.by_category[loc.category] = [];
      indices.by_category[loc.category].push(loc.id);
    }
    
    // Account
    if (loc.account?.account_id) {
      const id = loc.account.account_id;
      if (!indices.by_account[id]) indices.by_account[id] = [];
      indices.by_account[id].push(loc.id);
    }
  }
  
  // Build confusion groups
  const confusionGroups = [];
  const confusionMap = new Map();
  
  for (const loc of allLocations) {
    if (loc.confusion_matrix) {
      for (const confusion of loc.confusion_matrix) {
        const key = [loc.id, confusion.confused_with].sort().join('|');
        if (!confusionMap.has(key)) {
          confusionMap.set(key, {
            members: [loc.id, confusion.confused_with],
            disambiguation_script: confusion.disambiguation
          });
        }
      }
    }
  }
  
  confusionGroups.push(...confusionMap.values());
  
  // Output
  const output = {
    version: "2.0.0",
    updated_at: new Date().toISOString(),
    service_area: {
      towns: townData,
      primary_towns: ["aspen", "snowmass", "basalt", "carbondale", "glenwood_springs"],
      extended_towns: ["vail", "avon", "edwards", "eagle"]
    },
    locations: allLocations,
    indices,
    confusion_groups
  };
  
  const outputPath = path.join(__dirname, '..', 'locations.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  
  const minPath = path.join(__dirname, '..', 'locations.min.json');
  fs.writeFileSync(minPath, JSON.stringify(output));
  
  console.log(`\n✅ Combined ${allLocations.length} locations`);
  console.log(`📁 ${outputPath}`);
  console.log(`📦 ${minPath}`);
}

combineLocations();