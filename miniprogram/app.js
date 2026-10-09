const THEMES = {
  ink: { name: '尘迹', selected: '#a9322b', background: '#f5f0e7', icon: 'ink' },
  classic: { name: '经典蓝', selected: '#2865da', background: '#f5f7fb', icon: 'classic' }
};

App({
  globalData: { theme: 'ink' },
  onLaunch() {
    this.applyTheme(wx.getStorageSync('theme') || 'ink');
  },
  applyTheme(theme) {
    if (!THEMES[theme]) theme = 'ink';
    this.globalData.theme = theme;
    const config = THEMES[theme];
    wx.setStorageSync('theme', theme);
    wx.setBackgroundColor({ backgroundColor: config.background, backgroundColorTop: config.background, backgroundColorBottom: config.background });
    wx.setTabBarStyle({ selectedColor: config.selected, backgroundColor: theme === 'classic' ? '#ffffff' : '#fffdf8' });
    const icon = config.icon;
    const items = [
      ['pages/home/index', '首页', 'home'],
      ['pages/students/index', '学员', 'students'],
      ['pages/manage/index', '管理', 'manage']
    ];
    items.forEach(([pagePath, text, name]) => wx.setTabBarItem({
      index: items.findIndex(item => item[0] === pagePath), pagePath, text,
      iconPath: `assets/tabbar/${name}-${icon}.png`,
      selectedIconPath: `assets/tabbar/${name}-selected-${icon}.png`
    }));
    return theme;
  },
  getThemeClass() { return this.globalData.theme === 'classic' ? 'theme-classic' : ''; },
  getThemes() { return THEMES; }
});
