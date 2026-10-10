# QCOM Delivery Partner App - Design System & Visual Guidelines

## 1. Design Language & Atmosphere
- **Archetype**: Premium Operational Commerce Software (inspired by Uber Driver, Stripe, Linear, Square).
- **Style**: Refined light operational canvas, warm off-white neutral page backgrounds (`bg-[#FBFBF9]`), clean elevated white surfaces (`bg-white`), subtle 1px borders (`border-neutral-200/80`), and restrained elevation.
- **Accent Palette**: Refined Emerald (`#059669` / `emerald-600`) as primary action & online status tone; Muted Indigo (`#4F46E5`) for navigation/transit states; Deep Neutral (`#111827`) for high-contrast operational text.
- **Anti-Vibe-Coding Strict Enforcement**:
  - NO purple/black AI gradients or cyan dark mode.
  - NO decorative rainbow badges or artificial bento grids.
  - NO rounded cards with mismatched nesting radii.
  - NO generic Lucide icon clutter or unrendered placeholder blocks.

## 2. Typography
- **Primary Typefaces**: Inter / Geist / SF Pro fallback stack.
- **Hierarchy**:
  - Operational Numbers: Bold, high-contrast, tight tracking for INR ₹ earnings and distance meters.
  - Heading 1: 20px / 24px semi-bold (`text-xl font-bold tracking-tight`).
  - Body Text: 14px - 16px (`text-sm` / `text-base`), minimum 1.5 line height.
  - Micro Badges & Statuses: 12px uppercase tracked labels (`text-[11px] font-semibold tracking-wider`).

## 3. Spacing & Touch Targets
- Touch targets: Minimum 48px height for all primary buttons (`h-12` or `h-14` on mobile).
- Container outer padding: `p-4` (16px) or `p-6` (24px).
- Dynamic nested radius rule: `Inner Radius = Outer Radius - Padding`.

## 4. Status Color Matrix
- **Online / Active**: Calm Emerald (`bg-emerald-50 text-emerald-700 border-emerald-200`).
- **In Transit / Picking Up**: Refined Indigo (`bg-indigo-50 text-indigo-700 border-indigo-200`).
- **Action Required / OTP**: Muted Amber (`bg-amber-50 text-amber-700 border-amber-200`).
- **Offline / Suspended**: Warm Gray (`bg-neutral-100 text-neutral-600 border-neutral-200`).
- **Urgent / Emergency**: Restrained Rose (`bg-rose-50 text-rose-700 border-rose-200`).

## 5. Responsive Strategy
- **Mobile First**: Single-hand bottom sheet drawers, sticky bottom primary CTA bar, thumb-friendly navigation.
- **Desktop Adaptation**: Multi-column operational view with side-by-side active navigation map, detail drawers, and ledger table.
