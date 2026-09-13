import type { Field, Scenario, Strategy, Resource } from './types.ts';
export const HORIZON = 48;
export const fields: Field[] = [
  {id:'river8',name:'River 8',crop:'Wheat',hectares:170,yield:3.6,price:310,moisture:11.4,ready:0,rainLoss:250,color:'#27866e'},
  {id:'north4',name:'North 4',crop:'Wheat',hectares:150,yield:3.2,price:310,moisture:14.2,ready:24,rainLoss:95,color:'#80bca9'},
  {id:'west2',name:'West 2',crop:'Canola',hectares:110,yield:1.8,price:650,moisture:7.8,ready:0,rainLoss:190,color:'#d6ad42'},
  {id:'south6',name:'South 6',crop:'Wheat',hectares:140,yield:3.4,price:300,moisture:11.8,ready:0,rainLoss:145,color:'#66a8ba'},
  {id:'east3',name:'East 3',crop:'Barley',hectares:100,yield:3.1,price:270,moisture:13.1,ready:8,rainLoss:80,color:'#b090c1'},
  {id:'hill5',name:'Hill 5',crop:'Wheat',hectares:130,yield:3,price:300,moisture:14.7,ready:30,rainLoss:60,color:'#de9372'},
];
export const farmArea = fields.reduce((n,f)=>n+f.hectares,0);
export const grossValue = fields.reduce((n,f)=>n+f.hectares*f.yield*f.price,0);
export const normal: Scenario = {rainAt:31,rainDuration:6,rainMm:22,probability:.72,h2Capacity:1,disrupted:false};
export const disruption: Scenario = {...normal,rainAt:17,h2Capacity:.7,disrupted:true};
export const resources: Resource[] = ['H1','H2','C1'];
export const strategies: Strategy[] = [
  {id:'restricted',label:'Use permitted H2 capacity',h2:true,contractor:false},
  {id:'contractor',label:'Permitted H2 + contractor',h2:true,contractor:true},
  {id:'stop',label:'Stop H2',h2:false,contractor:false},
  {id:'stop-contractor',label:'Stop H2 + contractor',h2:false,contractor:true},
];
export const delivery = {tonnes:480,due:30,shortfallCost:65};
export const destinations = {receival:{capacity:1800,truckHourly:17.5,cost:9},storage:{capacity:1400,truckHourly:35,cost:4}};
export const contractor = {start:4,hours:9,rate:550,capacity:14};
export const workers = ['Alex · H1','Jordan · H2','Sam · T1','Casey · T2','Taylor · T3','Morgan · relief'];
export const exampleRule = 'North 4 gets boggy after heavy rain. Never send H2 there within 24 hours of more than 15 mm rainfall.';
export const isLabourAvailable = (hour:number) => !(hour>=12 && hour<14 || hour>=26 && hour<28 || hour>=40 && hour<42);
