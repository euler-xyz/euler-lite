export interface MenuItem {
  name: string
  label: string
  sublabel?: string
  icon: string
  activeIcon: string
}

const allMenuItems: MenuItem[] = [
  {
    name: 'portfolio',
    label: 'Portfolio',
    icon: 'nav-portfolio',
    activeIcon: 'nav-portfolio-filled',
  },
  {
    name: 'explore',
    label: 'Explore',
    icon: 'nav-explore',
    activeIcon: 'nav-explore-filled',
  },
  {
    name: 'earn',
    label: 'Earn',
    icon: 'nav-earn',
    activeIcon: 'nav-earn-filled',
  },
  {
    name: 'lend',
    label: 'Lend',
    icon: 'nav-lend',
    activeIcon: 'nav-lend-filled',
  },
  {
    name: 'borrow',
    label: 'Borrow',
    sublabel: 'Multiply',
    icon: 'nav-borrow',
    activeIcon: 'nav-borrow-filled',
  },
]

export const getMenuItems = (enableEarnPage: boolean, enableLendPage: boolean, enableExplorePage: boolean) => {
  return allMenuItems.filter((item) => {
    if (item.name === 'explore' && !enableExplorePage) return false
    if (item.name === 'lend' && !enableLendPage) return false
    if (item.name === 'earn' && !enableEarnPage) return false
    return true
  })
}

const preferredDefaultOrder = ['explore', 'earn', 'lend', 'borrow', 'portfolio'] as const

export const getDefaultPageRoute = (enableEarnPage: boolean, enableLendPage: boolean, enableExplorePage: boolean) => {
  const items = getMenuItems(enableEarnPage, enableLendPage, enableExplorePage)
  return preferredDefaultOrder.find(name =>
    items.some(item => item.name === name),
  ) ?? 'portfolio'
}
