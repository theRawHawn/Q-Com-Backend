import React from 'react';

export interface IconProps {
  className?: string;
  size?: number;
}

/**
 * Custom Screw & Nut Icon (Threaded screw bolt alongside a hexagonal nut)
 */
export const ScrewNutIcon: React.FC<IconProps> = ({ className = "w-5 h-5", size }) => {
  return (
    <svg 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
      style={size ? { width: size, height: size } : undefined}
    >
      {/* Screw on Left */}
      <g>
        {/* Screw Head */}
        <rect x="3" y="3" width="7" height="2.5" rx="0.5" />
        <line x1="6.5" y1="3" x2="6.5" y2="5.5" />
        {/* Screw Shank */}
        <path d="M4.5 5.5V17L6.5 21L8.5 17V5.5" />
        {/* Screw Threads */}
        <line x1="4.5" y1="8.5" x2="8.5" y2="10" />
        <line x1="4.5" y1="12" x2="8.5" y2="13.5" />
        <line x1="4.5" y1="15.5" x2="8.5" y2="17" />
      </g>

      {/* Hex Nut on Right */}
      <g>
        {/* Hexagon Nut Outline */}
        <polygon points="17.5,7 21.5,9.5 21.5,14.5 17.5,17 13.5,14.5 13.5,9.5" />
        {/* Center Thread Hole */}
        <circle cx="17.5" cy="12" r="2" />
        {/* Facet lines */}
        <line x1="17.5" y1="7" x2="17.5" y2="10" />
        <line x1="17.5" y1="14" x2="17.5" y2="17" />
      </g>
    </svg>
  );
};

/**
 * Custom Cutting Machine (Angle Grinder / Tile & Marble Cutter) with Disc Icon
 */
export const CuttingMachineDiscIcon: React.FC<IconProps> = ({ className = "w-5 h-5", size }) => {
  return (
    <svg 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
      style={size ? { width: size, height: size } : undefined}
    >
      {/* Machine Motor Body / Handle */}
      <rect x="2" y="11" width="9" height="4" rx="1.5" />
      <line x1="1" y1="13" x2="2" y2="13" />
      
      {/* Gear Head */}
      <path d="M11 10.5H14V15.5H11" />
      
      {/* Side Handle on Machine */}
      <line x1="12.5" y1="10.5" x2="12.5" y2="6.5" strokeWidth="2.2" />
      <line x1="11" y1="6.5" x2="14" y2="6.5" />

      {/* Disc Protective Guard Half-Shield */}
      <path d="M13.5 8.5C15 7.5 17.5 7.5 19.5 9" strokeWidth="2.2" />

      {/* Circular Cutting Disc Blade */}
      <circle cx="17.5" cy="14.5" r="5" />
      {/* Center Arbor Nut */}
      <circle cx="17.5" cy="14.5" r="1.2" fill="currentColor" />
      {/* Disc Cutting Segments / Slots */}
      <line x1="17.5" y1="9.5" x2="17.5" y2="11.5" />
      <line x1="17.5" y1="17.5" x2="17.5" y2="19.5" />
      <line x1="12.5" y1="14.5" x2="14.5" y2="14.5" />
      <line x1="20.5" y1="14.5" x2="22.5" y2="14.5" />
    </svg>
  );
};

/**
 * Crossed Hammer and Spanner / Wrench Icon
 */
export const CrossedHammerWrenchIcon: React.FC<IconProps> = ({ className = "w-5 h-5", size }) => {
  return (
    <svg 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth="2" 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
      style={size ? { width: size, height: size } : undefined}
    >
      {/* Hammer (Diagonal top-right to bottom-left) */}
      <g>
        {/* Hammer Head */}
        <path d="M14.5 3.5L20.5 7.5L19 9.5L17 8L15 9.5L13 6.5L14.5 3.5Z" />
        {/* Hammer Handle */}
        <line x1="14.5" y1="8" x2="4" y2="20" strokeWidth="2.4" />
      </g>

      {/* Spanner / Wrench (Diagonal top-left to bottom-right) */}
      <g>
        {/* Open Spanner Head (top-left) */}
        <path d="M4.5 8C3.5 6.5 4 4.5 5.5 3.5C6.8 2.7 8.2 2.8 9.2 3.8L7.2 6.5L8.5 7.8L10.5 5.2C11.2 6.2 11 7.8 10 9" />
        {/* Spanner Handle */}
        <line x1="8.5" y1="8" x2="19.5" y2="20" strokeWidth="2.4" />
        {/* Spanner End Ring */}
        <circle cx="19.5" cy="20" r="1.5" />
      </g>
    </svg>
  );
};

