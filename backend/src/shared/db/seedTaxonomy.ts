export type SeedArticle = { title: string; body: string; keywords: string[] }
export type SeedIntent = { name: string; subintents: string[]; articles: SeedArticle[] }

/** Dev seed data shared by `seed.ts` and `scripts/setup-weaviate-collection.ts` — one source of truth so the two never drift apart. */
export const SEED_TAXONOMY: SeedIntent[] = [
  {
    name: 'Billing',
    subintents: ['Subscription Issues', 'Invoice Questions', 'Refund Requests', 'Payment Methods', 'Billing Errors'],
    articles: [
      { title: 'Understanding Your Subscription', body: 'Learn how to manage your subscription, view billing history, and update payment methods.', keywords: ['subscription', 'billing', 'payment', 'renewal'] },
      { title: 'Refund Policy and Process', body: 'Information about our refund policy, how to request a refund, and typical processing times.', keywords: ['refund', 'money back', 'return', 'policy'] },
    ],
  },
  {
    name: 'Account Access',
    subintents: ['Password Reset', 'Two-Factor Auth', 'Account Recovery', 'Email Change', 'Account Deletion'],
    articles: [
      { title: 'Resetting Your Password', body: 'Step-by-step guide to reset your password and regain access to your account.', keywords: ['password', 'reset', 'forgot', 'locked out'] },
      { title: 'Two-Factor Authentication Setup', body: 'Secure your account with two-factor authentication. Learn how to enable and use 2FA.', keywords: ['2fa', 'security', 'authentication', 'login'] },
    ],
  },
  {
    name: 'Technical Issues',
    subintents: ['Game Crashes', 'Performance Issues', 'Connection Problems', 'Battery Drain', 'Storage Issues'],
    articles: [
      { title: 'Troubleshooting Game Crashes', body: 'Common causes of game crashes and steps to resolve them on your device.', keywords: ['crash', 'bug', 'error', 'freeze'] },
      { title: 'Improving Game Performance', body: 'Tips and tricks to optimize your game performance and reduce lag.', keywords: ['lag', 'slow', 'fps', 'performance'] },
    ],
  },
  {
    name: 'Gameplay Help',
    subintents: ['How to Play', 'Tips & Tricks', 'Game Progression', 'Achievements', 'Level Guides'],
    articles: [
      { title: 'Getting Started Guide', body: 'A comprehensive guide for new players covering the basics of gameplay.', keywords: ['tutorial', 'beginner', 'how to', 'basics'] },
      { title: 'Advanced Tips and Strategies', body: 'Pro tips and strategies to progress faster and achieve higher scores.', keywords: ['strategy', 'tips', 'advanced', 'level up'] },
    ],
  },
  {
    name: 'In-App Purchases',
    subintents: ['Missing Purchase', 'Double Charge', 'Item Not Received', 'Promo Codes', 'Refund Status'],
    articles: [
      { title: 'How to Make In-App Purchases', body: 'Learn how to safely purchase items and currency within the game.', keywords: ['purchase', 'buy', 'currency', 'items'] },
      { title: 'Troubleshooting Purchase Issues', body: 'Common purchase problems and how to resolve them.', keywords: ['purchase failed', 'transaction', 'error', 'payment issue'] },
    ],
  },
  {
    name: 'Social Features',
    subintents: ['Friend Issues', 'Clan Management', 'Leaderboard Problems', 'Chat Issues', 'Guild Help'],
    articles: [
      { title: 'Managing Your Friends List', body: 'How to add friends, manage friend requests, and interact with other players.', keywords: ['friends', 'add', 'invite', 'multiplayer'] },
      { title: 'Joining and Managing Clans', body: 'Create or join a clan, manage clan membership, and participate in clan events.', keywords: ['clan', 'guild', 'team', 'group'] },
    ],
  },
  {
    name: 'Data & Sync',
    subintents: ['Lost Progress', 'Sync Failures', 'Device Transfer', 'Data Recovery', 'Cloud Backup'],
    articles: [
      { title: 'Backing Up Your Progress', body: 'How to back up your game progress and transfer it to a new device.', keywords: ['backup', 'restore', 'transfer', 'cloud'] },
      { title: 'Recovering Lost Progress', body: 'Steps to take if your progress is lost or not syncing correctly.', keywords: ['lost progress', 'sync', 'recovery', 'data loss'] },
    ],
  },
  {
    name: 'Events & Promotions',
    subintents: ['Event Participation', 'Reward Issues', 'Limited Time Events', 'Seasonal Content', 'Bonus Tracking'],
    articles: [
      { title: 'Current Events and Rewards', body: 'Information about ongoing events, how to participate, and earn exclusive rewards.', keywords: ['event', 'rewards', 'promotion', 'exclusive'] },
      { title: 'Seasonal Content Guide', body: 'Learn about seasonal events, limited-time items, and special promotions.', keywords: ['seasonal', 'limited time', 'special', 'event'] },
    ],
  },
]
