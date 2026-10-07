export const planSchema={type:'object',additionalProperties:false,required:['title','reasoning','layers'],properties:{
  title:{type:'string'},reasoning:{type:'string'},layers:{type:'array',minItems:2,maxItems:36,items:{
    type:'object',additionalProperties:false,required:['id','name','kind','description','bbox','occludedBy','hiddenContent','extractionPrompt','risk'],properties:{
      id:{type:'string',pattern:'^[a-z][a-z0-9_-]*$'},name:{type:'string'},
      kind:{type:'string',enum:['background','product','text','decoration','shadow','effect','other']},
      description:{type:'string'},bbox:{type:'object',additionalProperties:false,required:['x','y','width','height'],properties:{
        x:{type:'integer',minimum:0,maximum:1000},y:{type:'integer',minimum:0,maximum:1000},
        width:{type:'integer',minimum:1,maximum:1000},height:{type:'integer',minimum:1,maximum:1000}}},
      occludedBy:{type:'array',items:{type:'string'}},hiddenContent:{type:'string'},extractionPrompt:{type:'string'},risk:{type:'string'}
    }
  }}}};
