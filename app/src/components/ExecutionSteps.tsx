type Event={tool:string;state:string};
type Line={suggestedPrice?:number;source?:string};
const labels:Record<string,string>={read_inquiry:'读取物料需求',lookup_costs:'匹配库存与成本',build_quote_draft:'整理报价结果'};

/** Public execution receipt derived exclusively from observed tool events and results. */
export function ExecutionSteps({events,lines=[],running=false,mode}:{events:Event[];lines?:Line[];running?:boolean;mode?:string}) {
  const steps=Object.keys(labels).flatMap(tool=>{
    const matching=events.filter(value=>value.tool===tool);
    const event=matching[matching.length-1];
    return event?[event]:[];
  });
  if(!steps.length)return null;
  const detail=(event:Event)=>{
    if(event.state==='started')return '处理中';
    if(event.state!=='done')return '本步尚未完成';
    if(!lines.length)return '已完成';
    if(event.tool==='read_inquiry')return `${lines.length} 行物料`;
    if(event.tool==='lookup_costs')return `${lines.filter(line=>line.source).length} 行有可用成本依据`;
    return mode==='analysis'?`${lines.length} 行核对结果`:`${lines.filter(line=>line.suggestedPrice!=null).length} 行建议价，等待人工核对`;
  };
  return <ol className="execution-steps" aria-label={running?'正在处理询价':'本轮处理过程'}>{steps.map(event=><li key={event.tool} data-state={event.state}><span aria-hidden="true">{event.state==='done'?'✓':'·'}</span><div><strong>{labels[event.tool]}</strong><p>{detail(event)}</p></div></li>)}</ol>;
}
