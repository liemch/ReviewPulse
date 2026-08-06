/** Inline SVG icon set (no icon dependency). */

import type { SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  size?: number;
};

function Icon({ size = 18, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export function IconShield(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7 3v5.5c0 4.3-2.9 7.9-7 9.5-4.1-1.6-7-5.2-7-9.5V6l7-3z" />
      <path d="M9.2 12.2l2 2 3.6-3.9" />
    </Icon>
  );
}

export function IconPulse(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 12h3.2l2-4.6 3 9.2 2.3-6 1.7 3.4H21" />
    </Icon>
  );
}

export function IconGitBranch(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 4v10.5" />
      <circle cx="6" cy="17.5" r="2.3" />
      <circle cx="6" cy="4" r="1.6" />
      <circle cx="17.5" cy="7" r="2.3" />
      <path d="M17.5 9.3v1.2a4 4 0 01-4 4H8.2" />
    </Icon>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.5h7A1.5 1.5 0 0119 10v7.5A1.5 1.5 0 0117.5 19h-13A1.5 1.5 0 013 17.5v-10z" />
    </Icon>
  );
}

export function IconUsers(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="9.5" cy="8.5" r="3" />
      <path d="M3.5 19.5c0-3 2.7-5 6-5s6 2 6 5" />
      <path d="M16.5 6.4a3 3 0 010 5.7" />
      <path d="M18 14.9c1.7.7 2.8 2.1 2.8 4.1" />
    </Icon>
  );
}

export function IconListCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7.2l1.6 1.6L8.6 5.6" />
      <path d="M4 16.2l1.6 1.6 3-3.2" />
      <path d="M11.5 7.4H20" />
      <path d="M11.5 16.6H20" />
    </Icon>
  );
}

export function IconLogOut(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 5.5H6.8A1.8 1.8 0 005 7.3v9.4a1.8 1.8 0 001.8 1.8H14" />
      <path d="M16.5 8.7L19.8 12l-3.3 3.3" />
      <path d="M19.5 12h-8.6" />
    </Icon>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 11.4a8 8 0 10-2.6 6" />
      <path d="M20 5.5v5.9h-5.6" />
    </Icon>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.4A1 1 0 0110.5 4.4h3a1 1 0 011 1V7" />
      <path d="M6.5 7l.8 11.2A1.6 1.6 0 018.9 20h6.2a1.6 1.6 0 001.6-1.5L17.5 7" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5.5v13" />
      <path d="M5.5 12h13" />
    </Icon>
  );
}

export function IconKey(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="12" r="3.4" />
      <path d="M11.4 12H20" />
      <path d="M16.6 12v3.1" />
      <path d="M19.2 12v2.2" />
    </Icon>
  );
}

export function IconClock(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.8V12l3 1.8" />
    </Icon>
  );
}

export function IconCheckCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M8.6 12.3l2.2 2.2 4.5-4.8" />
    </Icon>
  );
}

export function IconAlertCircle(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 8.2v4.6" />
      <path d="M12 15.6v.6" />
    </Icon>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11.2v4.6" />
      <path d="M12 8v.6" />
    </Icon>
  );
}

export function IconInbox(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 13.5L6.4 6.6A1.6 1.6 0 018 5.5h8a1.6 1.6 0 011.6 1.1L20 13.5" />
      <path d="M4 13.5h4.2l1 2.2h5.6l1-2.2H20v3.4a1.6 1.6 0 01-1.6 1.6H5.6A1.6 1.6 0 014 16.9v-3.4z" />
    </Icon>
  );
}

export function IconLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.4 13.6a3.6 3.6 0 010-5l1.7-1.8a3.6 3.6 0 015.1 5.1l-1 1" />
      <path d="M13.6 10.4a3.6 3.6 0 010 5.1l-1.7 1.7a3.6 3.6 0 01-5.1-5.1l1-1" />
    </Icon>
  );
}
