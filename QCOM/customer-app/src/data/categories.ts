import { 
  Droplet, 
  Zap, 
  TestTube, 
  ShieldCheck, 
  ShoppingBag,
  DoorOpen,
  Lightbulb,
  Fan,
  ToggleRight,
  ShowerHead,
  UtensilsCrossed,
  Hammer,
  Layers,
  Wrench,
  Disc,
  Scissors,
  ShieldAlert
} from 'lucide-react';
import { ScrewNutIcon, CuttingMachineDiscIcon, CrossedHammerWrenchIcon } from '../components/CustomIcons';
import { TradeCategory, HardwareProduct } from '../types';

export interface SubCategoryItem {
  id: string; // e.g. 'all', 'lighting', 'fans', 'switches', 'wires_mcbs'
  label: string; // e.g. 'Lighting & Bulbs'
  shortLabel?: string;
  icon?: any;
  filterFn?: (product: HardwareProduct) => boolean;
}

export interface MainCategoryConfig {
  id: TradeCategory;
  label: string;
  shortLabel?: string;
  icon: any;
  description: string;
  subcategories: SubCategoryItem[];
  // Categories in products data that map to this main category
  productCategories: TradeCategory[];
}

export const MAIN_CATEGORIES: MainCategoryConfig[] = [
  {
    id: 'all',
    label: 'All',
    shortLabel: 'All',
    icon: ShoppingBag,
    description: 'Browse complete hardware catalogue & emergency rescues',
    productCategories: [
      'all', 'electrical', 'lighting', 'fans', 'switches', 
      'plumbing', 'bathroom_fittings', 'kitchen_fittings',
      'screws', 'fasteners', 'tools', 'cutting_discs', 'cutters',
      'carpentry', 'adhesives', 'safety'
    ],
    subcategories: []
  },
  {
    id: 'electrical',
    label: 'Electrical',
    shortLabel: 'Electrical',
    icon: Zap,
    description: 'Lighting, ceiling fans, modular switches, power sockets, wires & MCBs',
    productCategories: ['electrical', 'lighting', 'fans', 'switches'],
    subcategories: [
      {
        id: 'all',
        label: 'All Electrical',
        icon: Zap,
        filterFn: (p) => ['electrical', 'lighting', 'fans', 'switches'].includes(p.category)
      },
      {
        id: 'lighting',
        label: 'Lighting & Bulbs',
        icon: Lightbulb,
        filterFn: (p) => p.category === 'lighting'
      },
      {
        id: 'fans',
        label: 'Fans & Regulators',
        icon: Fan,
        filterFn: (p) => p.category === 'fans'
      },
      {
        id: 'switches',
        label: 'Switches & Sockets',
        icon: ToggleRight,
        filterFn: (p) => p.category === 'switches'
      },
      {
        id: 'wires_mcbs',
        label: 'Wires, MCBs & Tape',
        icon: Zap,
        filterFn: (p) => p.category === 'electrical'
      }
    ]
  },
  {
    id: 'plumbing',
    label: 'Plumbing & Bath',
    shortLabel: 'Plumbing',
    icon: Droplet,
    description: 'Bathroom fittings, shower arms, pillar taps, flexible pipes & valves',
    productCategories: ['plumbing', 'bathroom_fittings'],
    subcategories: [
      {
        id: 'all',
        label: 'All Plumbing & Bath',
        icon: Droplet,
        filterFn: (p) => ['plumbing', 'bathroom_fittings'].includes(p.category)
      },
      {
        id: 'bathroom_fittings',
        label: 'Bathroom Fittings',
        icon: ShowerHead,
        filterFn: (p) => p.category === 'bathroom_fittings'
      },
      {
        id: 'pipes_valves',
        label: 'Valves, Pipes & Teflon',
        icon: Droplet,
        filterFn: (p) => p.category === 'plumbing'
      }
    ]
  },
  {
    id: 'kitchen_fittings',
    label: 'Kitchen',
    shortLabel: 'Kitchen',
    icon: UtensilsCrossed,
    description: 'Flexible sink cock taps, stainless waste couplings, drain pipes & RO adapters',
    productCategories: ['kitchen_fittings'],
    subcategories: [
      {
        id: 'all',
        label: 'All Kitchen',
        icon: UtensilsCrossed,
        filterFn: (p) => p.category === 'kitchen_fittings'
      },
      {
        id: 'sink_taps',
        label: 'Sink Taps & Faucets',
        icon: UtensilsCrossed,
        filterFn: (p) => p.category === 'kitchen_fittings' && (
          p.tags.some(t => t.includes('tap') || t.includes('faucet') || t.includes('cock')) ||
          p.name.toLowerCase().includes('tap') || p.name.toLowerCase().includes('faucet')
        )
      },
      {
        id: 'waste_drain',
        label: 'Waste Couplings & Pipes',
        icon: Droplet,
        filterFn: (p) => p.category === 'kitchen_fittings' && (
          p.tags.some(t => t.includes('waste') || t.includes('coupling') || t.includes('drain') || t.includes('pipe')) ||
          p.name.toLowerCase().includes('waste') || p.name.toLowerCase().includes('drain') || p.name.toLowerCase().includes('coupling')
        )
      },
      {
        id: 'ro_valves',
        label: 'RO Purifier & Valves',
        icon: Wrench,
        filterFn: (p) => p.category === 'kitchen_fittings' && (
          p.tags.some(t => t.includes('ro') || t.includes('purifier') || t.includes('valve')) ||
          p.name.toLowerCase().includes('ro') || p.name.toLowerCase().includes('purifier')
        )
      }
    ]
  },
  {
    id: 'screws',
    label: 'Screws & Nuts',
    shortLabel: 'Screws',
    icon: ScrewNutIcon,
    description: 'Machine screws, drywall screws, rawl plugs & concrete wedge anchors',
    productCategories: ['screws', 'fasteners'],
    subcategories: [
      {
        id: 'all',
        label: 'All Screws & Nuts',
        icon: ScrewNutIcon,
        filterFn: (p) => ['screws', 'fasteners'].includes(p.category)
      },
      {
        id: 'screws',
        label: 'Screws & Bolts',
        icon: ScrewNutIcon,
        filterFn: (p) => p.category === 'screws'
      },
      {
        id: 'fasteners',
        label: 'Wall Plugs & Anchors',
        icon: Hammer,
        filterFn: (p) => p.category === 'fasteners'
      }
    ]
  },
  {
    id: 'tools',
    label: 'Tools & Cutters',
    shortLabel: 'Tools',
    icon: CrossedHammerWrenchIcon,
    description: 'Angle grinders, cutting discs, tile cutters, snips & SDS drill bits',
    productCategories: ['tools', 'cutting_discs', 'cutters'],
    subcategories: [
      {
        id: 'all',
        label: 'All Tools & Cutters',
        icon: CrossedHammerWrenchIcon,
        filterFn: (p) => ['tools', 'cutting_discs', 'cutters'].includes(p.category)
      },
      {
        id: 'cutting_discs',
        label: 'Cutters & Discs',
        icon: CuttingMachineDiscIcon,
        filterFn: (p) => p.category === 'cutting_discs'
      },
      {
        id: 'cutters',
        label: 'Snips & Cutters',
        icon: Scissors,
        filterFn: (p) => p.category === 'cutters'
      },
      {
        id: 'hand_tools',
        label: 'Power Tools & Bits',
        icon: Wrench,
        filterFn: (p) => p.category === 'tools'
      }
    ]
  },
  {
    id: 'carpentry',
    label: 'Carpentry',
    shortLabel: 'Carpentry',
    icon: DoorOpen,
    description: 'Mortise locks, brass hinges, telescopic channels & tower bolts',
    productCategories: ['carpentry'],
    subcategories: [
      {
        id: 'all',
        label: 'All Carpentry',
        icon: DoorOpen,
        filterFn: (p) => p.category === 'carpentry'
      },
      {
        id: 'locks',
        label: 'Door Locks & Handles',
        icon: DoorOpen,
        filterFn: (p) => p.category === 'carpentry' && (
          p.tags.some(t => t.includes('lock') || t.includes('handle') || t.includes('latches')) ||
          p.name.toLowerCase().includes('lock') || p.name.toLowerCase().includes('handle')
        )
      },
      {
        id: 'hinges',
        label: 'Hinges & Channel Slides',
        icon: Layers,
        filterFn: (p) => p.category === 'carpentry' && (
          p.tags.some(t => t.includes('hinge') || t.includes('channel') || t.includes('slide') || t.includes('hardware')) ||
          p.name.toLowerCase().includes('hinge') || p.name.toLowerCase().includes('channel') || p.name.toLowerCase().includes('slide')
        )
      }
    ]
  },
  {
    id: 'adhesives',
    label: 'Adhesives',
    shortLabel: 'Adhesives',
    icon: TestTube,
    description: 'CPVC solvent cement, epoxy steel, silicone caulk, M-Seal & WD-40',
    productCategories: ['adhesives'],
    subcategories: [
      {
        id: 'all',
        label: 'All Adhesives',
        icon: TestTube,
        filterFn: (p) => p.category === 'adhesives'
      },
      {
        id: 'solvent_epoxy',
        label: 'Solvent & Epoxy',
        icon: TestTube,
        filterFn: (p) => p.category === 'adhesives' && (
          p.tags.some(t => t.includes('solvent') || t.includes('epoxy') || t.includes('araldite')) ||
          p.name.toLowerCase().includes('solvent') || p.name.toLowerCase().includes('epoxy') || p.name.toLowerCase().includes('araldite')
        )
      },
      {
        id: 'sealant_foam',
        label: 'Silicone & PU Foam',
        icon: Layers,
        filterFn: (p) => p.category === 'adhesives' && (
          p.tags.some(t => t.includes('silicone') || t.includes('foam') || t.includes('pu')) ||
          p.name.toLowerCase().includes('silicone') || p.name.toLowerCase().includes('foam')
        )
      },
      {
        id: 'mseal_wd40',
        label: 'M-Seal, Tape & Sprays',
        icon: Wrench,
        filterFn: (p) => p.category === 'adhesives' && (
          p.tags.some(t => t.includes('m-seal') || t.includes('wd-40') || t.includes('spray') || t.includes('putty')) ||
          p.name.toLowerCase().includes('m-seal') || p.name.toLowerCase().includes('wd-40') || p.name.toLowerCase().includes('spray')
        )
      }
    ]
  },
  {
    id: 'safety',
    label: 'Safety',
    shortLabel: 'Safety',
    icon: ShieldCheck,
    description: 'Anti-fog safety goggles, heavy nitrile grip gloves, helmets & masks',
    productCategories: ['safety'],
    subcategories: [
      {
        id: 'all',
        label: 'All Safety Gear',
        icon: ShieldCheck,
        filterFn: (p) => p.category === 'safety'
      },
      {
        id: 'eye_hand',
        label: 'Goggles & Gloves',
        icon: ShieldCheck,
        filterFn: (p) => p.category === 'safety' && (
          p.tags.some(t => t.includes('goggle') || t.includes('glove')) ||
          p.name.toLowerCase().includes('goggle') || p.name.toLowerCase().includes('glove')
        )
      },
      {
        id: 'head_mask',
        label: 'Helmets & Dust Masks',
        icon: ShieldAlert,
        filterFn: (p) => p.category === 'safety' && (
          p.tags.some(t => t.includes('helmet') || t.includes('mask') || t.includes('earplug')) ||
          p.name.toLowerCase().includes('helmet') || p.name.toLowerCase().includes('mask')
        )
      }
    ]
  }
];

export function getMainCategoryConfig(categoryId: TradeCategory): MainCategoryConfig {
  const found = MAIN_CATEGORIES.find(c => c.id === categoryId);
  return found || MAIN_CATEGORIES[0];
}
