import { delivery, fields, grossValue, contractor } from './data.ts';
import type { Economics } from './types.ts';
export function evaluateEconomics(input:{preRainRemaining:Record<string,number>;remaining:Record<string,number>;probability:number;machineCost:number;transportCost:number;hire:boolean;deliveredOnTime:number}):Economics {
  const weatherLoss = fields.reduce((n,f)=>n+input.preRainRemaining[f.id]*f.rainLoss*input.probability,0);
  // Residual work is valued as future harvest, with a separate near-term delay allowance.
  // Gross crop value is constant across plans; it is not counted again for harvested grain.
  const delayCost = Object.values(input.remaining).reduce((n,ha)=>n+ha*85,0);
  const deliveryPenalty = Math.max(0,delivery.tonnes-input.deliveredOnTime)*delivery.shortfallCost;
  const contractorCost = input.hire?contractor.rate*contractor.hours:0;
  const totalCost = weatherLoss+delayCost+deliveryPenalty+contractorCost+input.machineCost+input.transportCost;
  return {weatherLoss,delayCost,deliveryPenalty,contractorCost,machineCost:input.machineCost,transportCost:input.transportCost,totalCost,contribution:grossValue-totalCost};
}
