// Description:
//   毎日ログインボーナスでもらった「めりたん」というポイントを使って遊ぶSlack用チャットボットゲーム

import { Robot, Response, User } from 'hubot';
import { Sequelize, Op } from 'sequelize';
import moment from 'moment';

import { database } from './models/sequelizeLoader';

import { Account } from './models/accounts';
import { LoginBonus } from './models/loginBonuses';

import { Slack, SlackBot } from './types/meritum';

const LOGIN_BONUS_MERITUN = 100;
const BOT_INITIAL_MERITUM = 20000; // ボットの初期めりたん
const MAX_JANKEN_BET = 10; // 最大ベット

/**
 * ログインボーナス受領日を取得する、午前7時に変わるため、7時間前の時刻を返す
 * @returns {Date} 7時間前の時刻
 */
function getReceiptToday(): Date {
  return new Date(Date.now() - 1000 * 60 * 60 * 7);
}

// DB同期
(async () => {
  await Account.sync();
  await LoginBonus.sync();
})();

module.exports = (robot: Robot<any>) => {
  // ヘルプ表示
  robot.hear(/^mhelp>$/i, (res: Response<Robot<any>>) => {
    res.send(
      'プロジェクトmeritumとは、めりたんを集めるプロジェクト。' +
        '毎日のログインボーナスを集めて、ガチャを回し、称号を集めよう！' +
        '他人に迷惑をかけたりしないように！めりたんが消滅します！' +
        'めりたんbotをランキング100以下にしたら勝利！\n' +
        '■コマンド説明\n' +
        '`mhelp>` : めりたんbotの使い方を表示。\n' +
        '`mlogin>` : ログインボーナスの100めりたんをゲット。毎朝7時にリセット。\n' +
        '`mjanken> (グー|チョキ|パー) (1-9)` : めりたんbotと数値で指定しためりたんを賭けてジャンケン。\n' +
        '`mgacha>` : 80めりたんでガチャを回して称号をゲット。\n' +
        '`mself>` : 自分のめりたん、称号数、全称号、順位を表示。\n' +
        '`mranking>` : 称号数、次にめりたんで決まるランキングを表示。\n' +
        '`mrank> (@ユーザー名)` : 指定したユーザーのめりたん、称号数、全称号、順位を表示。\n' +
        '`msend> (@ユーザー名) (数値)` : 指定したユーザーに数値で指定しためりたんを送る'
    );
  });

  // ログインボーナス
  robot.hear(/^mlogin>$/i, async (res: Response<Robot<any>>) => {
    const user = res.message.user;
    const slackId = user.id;
    const name = user.name;
    const realName = user.real_name;
    const slack = user.slack as Slack;
    const displayName = slack.profile.display_name;

    const t = await database.transaction();
    try {
      const receiptDate = getReceiptToday();
      const countLoginBonus = await LoginBonus.count({
        where: {
          slackId: slackId,
          receiptDate: {
            [Op.eq]: receiptDate
          }
        }
      });

      if (countLoginBonus === 1) {
        // 取得済み
        await t.commit();
        res.send(
          `<@${slackId}>さんは、既に本日のログインボーナスを取得済みです。`
        );
      } else {
        // 付与へ
        // アカウントがない場合には作り、100めりたん付与、ログインボーナス実績を追加
        const oldAccount = await Account.findByPk(slackId);
        let meritum = 0;
        if (!oldAccount) {
          meritum = LOGIN_BONUS_MERITUN;
          await Account.create({
            slackId,
            name,
            realName,
            displayName,
            meritum,
            titles: '',
            numOfTitles: 0
          });
        } else {
          meritum = oldAccount.meritum + LOGIN_BONUS_MERITUN;
          await Account.update(
            { meritum },
            {
              where: {
                slackId: slackId
              }
            }
          );
        }

        // ログインボーナス実績を作成
        await LoginBonus.create({
          slackId,
          receiptDate
        });

        await t.commit();
        res.send(
          `<@${slackId}>さんにログインボーナスとして *${LOGIN_BONUS_MERITUN}めりたん* を付与し、 *${meritum}めりたん* となりました。`
        );
      }
    } catch (e) {
      console.log('Error on mlogin> e:');
      console.log(e);
      await t.rollback();
    }
  });

  // ジャンケン
  robot.hear(
    /^mjanken> (グー|チョキ|パー) (\d+)$/i,
    async (res: Response<Robot<any>>) => {
      const user = res.message.user;
      const slackId = user.id;
      const name = user.name;
      const realName = user.real_name;
      const slack = user.slack as Slack;
      const displayName = slack.profile.display_name;
      const slackBot = robot.adapter as SlackBot;

      const hand = res.match[1];
      const bet = parseInt(res.match[2]);

      if (bet > MAX_JANKEN_BET) {
        res.send(
          `*${MAX_JANKEN_BET}めりたん* 以上をかけてジャンケンすることは禁止されています。`
        );
        return;
      }

      if (bet <= 0) {
        res.send(
          '*1めりたん* より小さな数の *めりたん* をかけることはできません。'
        );
        return;
      }

      const t = await database.transaction();
      try {
        // ボット自身に最低でも10めりたんあるかチェック
        let botAccount = await Account.findByPk(slackBot.self.id);
        if (!botAccount) {
          // ボットアカウントがない場合作る
          await Account.create({
            slackId: slackBot.self.id,
            name: slackBot.self.name,
            realName: '',
            displayName: '',
            meritum: BOT_INITIAL_MERITUM,
            titles: '',
            numOfTitles: 0
          });
          botAccount = await Account.findByPk(slackBot.self.id);
        } else if (botAccount.meritum < bet) {
          // ベット分持っていない場合、終了
          res.send(
            `<@${slackBot.self.id}>は *${bet}めりたん* を所有していないためジャンケンできません。`
          );
          await t.commit();
          return;
        }

        // ボットアカウントがない場合に作成してもまだないなら終了
        if (!botAccount) {
          console.log('ボットアカウントを作成することができませんでした。');
          await t.commit();
          return;
        }

        // 相手がベットできるかチェック
        const account = await Account.findByPk(slackId);
        if (!account) {
          // ボットアカウントがない場合作る
          const meritum = 0;
          await Account.create({
            slackId,
            name,
            realName,
            displayName,
            meritum,
            titles: '',
            numOfTitles: 0
          });

          res.send(
            `<@${slackId}>は *${bet}めりたん* を所有していないためジャンケンできません。 ログインボーナスを取得してください。`
          );
          await t.commit();
          return;
        } else if (account.meritum < bet) {
          // ベット分持っていない場合、終了
          res.send(
            `<@${slackId}>は *${bet}めりたん* を所有していないためジャンケンできません。`
          );
          await t.commit();
          return;
        }

        const botHands = ['グー', 'チョキ', 'パー'];
        const botHand = botHands[Math.floor(Math.random() * botHands.length)];

        if (botHand === hand) {
          res.send(
            `ジャンケン！ ${botHand}！... *あいこ* ですね。またの機会に。`
          );
          await t.commit();
          return;
        }

        const isBotWon =
          (botHand === 'グー' && hand === 'チョキ') ||
          (botHand === 'チョキ' && hand === 'パー') ||
          (botHand === 'パー' && hand === 'グー');

        if (isBotWon) {
          // 負け処理
          await Account.update(
            { meritum: account.meritum - bet },
            {
              where: {
                slackId: slackId
              }
            }
          );
          await Account.update(
            { meritum: botAccount.meritum + bet },
            {
              where: {
                slackId: slackBot.self.id
              }
            }
          );
          res.send(
            `ジャンケン！ ${botHand}！...あなたの *負け* ですね。 *${bet}めりたん* 頂きます。これで *${account.meritum -
              bet}めりたん* になりました。`
          );
        } else {
          // 勝ち処理
          await Account.update(
            { meritum: account.meritum + bet },
            {
              where: {
                slackId: slackId
              }
            }
          );
          await Account.update(
            { meritum: botAccount.meritum - bet },
            {
              where: {
                slackId: slackBot.self.id
              }
            }
          );
          res.send(
            `ジャンケン！ ${botHand}！...あなたの *勝ち* ですね。 *${bet}めりたん* お支払いします。これで *${account.meritum +
              bet}めりたん* になりました。`
          );
        }
        await t.commit();
      } catch (e) {
        console.log('Error on mjanken> e:');
        console.log(e);
        await t.rollback();
      }
    }
  );
};
