// Semantic grouping keeps PNGs intact; render order is checked separately.
export function makeHierarchy(layers,groups){
 const nodes=new Map(layers.map(l=>[l.id,{...l,type:'bitmap',originalName:l.name,name:l.name.replace(' [元画像の文字]','')} ]));
 for(const g of groups){if(nodes.has(g.id))throw new Error('Duplicate ID '+g.id);nodes.set(g.id,{...g,type:'group'});}
 const roots=groups.filter(g=>g.parent==='root').map(g=>g.id),seen=new Set();
 function visit(id,parent){const n=nodes.get(id);if(!n||seen.has(id))throw new Error('Missing/duplicate/cyclic node '+id);seen.add(id);
  if(n.type==='group'){
   if(n.parent!==parent||!n.children.length)throw new Error('Invalid parent '+id);
   n.layers=n.children.map(c=>visit(c,id));n.x=Math.min(...n.layers.map(c=>c.x));n.y=Math.min(...n.layers.map(c=>c.y));
   n.width=Math.max(...n.layers.map(c=>c.x+c.width))-n.x;n.height=Math.max(...n.layers.map(c=>c.y+c.height))-n.y;
  }return n;
 }
 const tree=roots.map(id=>visit(id,'root'));if(seen.size!==nodes.size)throw new Error('Unassigned nodes');return tree;
}
export function flattenTree(tree){return tree.flatMap(n=>n.type==='group'?flattenTree(n.layers):[n]);}
export function localizeTree(tree,offset={x:0,y:0},replace=new Map()){
 return tree.map(node=>{const n=replace.get(node.id)||node;return {...n,x:n.x-offset.x,y:n.y-offset.y,...(node.type==='group'?{layers:localizeTree(node.layers,node,replace)}:{})};});
}
