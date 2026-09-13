import { contractor, delivery, destinations, fields, farmArea, HORIZON, isLabourAvailable, resources, strategies } from './data.ts';
import { evaluateEconomics } from './economics.ts';
import { isProhibited } from './parser.ts';
import type { Assignment, Plan, Resource, Route, Rule, Scenario, SearchResult, Strategy } from './types.ts';
const fieldMap=Object.fromEntries(fields.map(f=>[f.id,f]));
function permutations(items:string[]):string[][] { if(items.length===0)return [[]]; return items.flatMap((v,i)=>permutations(items.filter((_,j)=>i!==j)).map(t=>[v,...t])); }
const orders=permutations(fields.map(f=>f.id));
export function simulate(scenario:Scenario,strategy:Strategy,route:Route,order:string[],rules:Rule[]=[],frozen?:Plan):Plan {
  const remaining=Object.fromEntries(fields.map(f=>[f.id,f.hectares]));
  let preRainRemaining={...remaining};
  const assignments:Assignment[]=[];
  const stored={storage:0,receival:0};
  let machineCost=0,transportCost=0,deliveredOnTime=0,beforeRain=0;
  const previous:Partial<Record<Resource,string>>={};
  const fixed = frozen ? new Map(frozen.assignments.map(a=>[`${a.hour}-${a.resource}`,a])) : undefined;
  for(let hour=0;hour<HORIZON;hour++){
    if(hour===scenario.rainAt) preRainRemaining={...remaining};
    if(hour>=scenario.rainAt && hour<scenario.rainAt+scenario.rainDuration || !isLabourAvailable(hour))continue;
    // Continuous hourly truck flow approximation, including round trips.
    const capacity={receival:Math.min(destinations.receival.capacity-stored.receival,(route==='split'?2:3)*destinations.receival.truckHourly),storage:Math.min(destinations.storage.capacity-stored.storage,(route==='split'?1:0)*destinations.storage.truckHourly)};
    for(const resource of resources){
      if(resource==='H2' && !strategy.h2)continue;
      if(resource==='C1' && (!strategy.contractor || hour<contractor.start || hour>=contractor.start+contractor.hours))continue;
      const rate=resource==='H1'?12:resource==='H2'?10*scenario.h2Capacity:contractor.capacity;
      if(rate<=0)continue;
      const old=fixed?.get(`${hour}-${resource}`);
      if(fixed&&!old)continue;
      const candidates=old?[old.field]:order;
      for(const id of candidates){
        const f=fieldMap[id];
        if(remaining[id]<.001 || hour<f.ready || rules.some(rule=>isProhibited(rule,resource,id,hour,scenario)))continue;
        // Receival accepts wheat only; on-farm storage represents segregated bins.
        let destination:'storage'|'receival';
        if(old)destination=old.destination;
        else destination=f.crop==='Wheat' && capacity.receival>0?'receival':'storage';
        if(f.crop!=='Wheat' && destination==='receival')continue;
        const maxTonnes=capacity[destination];
        if(maxTonnes<.001)continue;
        // 15 minutes are lost when a machine changes fields (not first assignment).
        const workFraction = previous[resource] && previous[resource] !== id ? 0.75 : 1;
        const hectares=Math.min(remaining[id],rate*workFraction,maxTonnes/f.yield,old?.hectares??Infinity);
        if(hectares<.001)continue;
        const tonnes=hectares*f.yield;
        remaining[id]-=hectares;
        capacity[destination]-=tonnes;
        stored[destination]+=tonnes;
        transportCost+=tonnes*destinations[destination].cost;
        if(resource !== 'C1') machineCost += (hectares / rate + (workFraction === 0.75 ? 0.25 : 0)) * (resource === 'H1' ? 210 : 175);
        if(destination==='receival' && hour+1<=delivery.due)deliveredOnTime+=tonnes;
        if(hour<scenario.rainAt)beforeRain+=hectares;
        assignments.push({hour,resource,field:id,hectares,destination,tonnes});
        previous[resource]=id;
        break;
      }
    }
  }
  if(scenario.rainAt>=HORIZON)preRainRemaining={...remaining};
  return {strategy,route,order:[...order],assignments,remaining,preRainRemaining,destinations:stored,harvested:farmArea-Object.values(remaining).reduce((a,b)=>a+b,0),beforeRain,exposed:farmArea-beforeRain,deliveredOnTime,economics:evaluateEconomics({preRainRemaining,remaining,probability:scenario.probability,machineCost,transportCost,hire:strategy.contractor,deliveredOnTime})};
}
export function optimise(scenario:Scenario,rules:Rule[]=[],incumbent?:Plan):SearchResult {
  const alternatives:Plan[]=[];
  let evaluated=0;
  for(const strategy of strategies){
    let best:Plan|undefined;
    for(const route of ['receival','split'] as Route[]){
      for(const order of orders){
        const plan=simulate(scenario,strategy,route,order,rules);
        evaluated++;
        if(!best || plan.economics.totalCost<best.economics.totalCost-.001)best=plan;
      }
    }
    alternatives.push(best!);
  }
  // Retain the prior feasible schedule as a candidate so re-planning cannot
  // make the score worse simply because a greedy ordering family misses it.
  if(incumbent){
    const retained=replay(incumbent,scenario,rules);
    evaluated++;
    const index=alternatives.findIndex(p=>p.strategy.id===retained.strategy.id);
    if(retained.economics.totalCost<alternatives[index].economics.totalCost)alternatives[index]=retained;
  }
  alternatives.sort((a,b)=>a.economics.totalCost-b.economics.totalCost);
  return {best:alternatives[0],alternatives,evaluated};
}
export function replay(plan:Plan,scenario:Scenario,rules:Rule[]=[]):Plan {
  return simulate(scenario,plan.strategy,plan.route,plan.order,rules,plan);
}
