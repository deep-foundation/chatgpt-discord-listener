import express from 'express';
import { generateApolloClient } from "@deep-foundation/hasura/client";
import { DeepClient, parseJwt } from "@deep-foundation/deeplinks/imports/client";
import http from 'http';
import { error } from 'console';

const app = express();

const GQL_URN = process.env.GQL_URN || 'localhost:3006/gql';
const GQL_SSL = process.env.GQL_SSL || 0;

const makeDeepClient = (token: string) => {
  if (!token) throw new Error('No token provided');
  const decoded = parseJwt(token);
  const linkId = decoded?.userId;
  const apolloClient = generateApolloClient({
    path: GQL_URN,
    ssl: !!+GQL_SSL,
    token,
  });
  const deepClient = new DeepClient({ apolloClient, linkId, token });
  return deepClient;
}

app.use(express.json());

app.get('/healthz', (req, res) => {
  res.json({});
});
app.post('/init', (req, res) => {
  res.json({});
});

const triggeredByLinkId = 380;
const deep = makeDeepClient("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2hhc3VyYS5pby9qd3QvY2xhaW1zIjp7IngtaGFzdXJhLWFsbG93ZWQtcm9sZXMiOlsiYWRtaW4iXSwieC1oYXN1cmEtZGVmYXVsdC1yb2xlIjoiYWRtaW4iLCJ4LWhhc3VyYS11c2VyLWlkIjoiMzgwIn0sImlhdCI6MTY4NzI3OTEwN30.y7MlFDVVgbBtCoyW2Z5HS0lUN7Bw1nzDKqV6Tkfnm40")

const startBot = async () => {
  const conversationTypeLinkId = await deep.id("@deep-foundation/chatgpt", "Conversation");
  const messageTypeLinkId = await deep.id("@deep-foundation/messaging", "Message");
  const authorTypeLinkId = await deep.id("@deep-foundation/messaging", "Author");
  const containTypeLinkId = await deep.id("@deep-foundation/core", "Contain");
  const replyTypeLinkId = await deep.id("@deep-foundation/messaging", 'Reply');
  const messagingTreeId = await deep.id("@deep-foundation/messaging", 'MessagingTree');
  const userLinkId = await deep.id("deep", "admin");

  const loadBotToken = async () => {
    const containTreeId = await deep.id('@deep-foundation/core', 'containTree');
    const tokenTypeId = await deep.id('@deep-foundation/chatgpt-discord-bot', 'BotToken');
    const { data: [{ value: { value: npmToken = undefined } = {} } = {}] = [] } = await deep.select({
      up: {
        tree_id: { _eq: containTreeId },
        parent: { id: { _eq: triggeredByLinkId } },
        link: { type_id: { _eq: tokenTypeId } }
      }
    });
    return npmToken;
  };

  const Discord = require("discord.js");
  const BOT_TOKEN = await loadBotToken();

  const discordClient = new Discord.Client({
    intents: [
      Discord.GatewayIntentBits.DirectMessages,
      Discord.GatewayIntentBits.Guilds,
      Discord.GatewayIntentBits.GuildMessages,
      Discord.GatewayIntentBits.MessageContent,
    ],
  });

  const botListenPromise = new Promise((resolve, reject) => {
    discordClient.on('ready', () => {
      console.log(`Logged in as ${discordClient.user.tag}!`);
    });

    discordClient.on('exit', (event) => {
      console.log(`Discord bot is exited`, event);
      throw new error({ exited: event });
    });

    discordClient.on('disconnected', (event) => {
      console.log(`Discord bot is disconnected.`, event);
      throw new error({ disconnected: event });
    });

    discordClient.on(Discord.Events.MessageCreate, async (message) => {
      const mentionPrefix = `<@${discordClient.user.id}>`;
      if (message.content.includes(mentionPrefix) && !message.author.bot) {
        const channelName = "" + message.channel.id;
        let messageContent;

        if (message.reference) {
          console.log("replyToMessageId:" + message.reference.messageID);
          const replyToMessage = await message.fetchReference();
          console.log("reply text:" + replyToMessage.content);
          messageContent = `# quoted
          ${replyToMessage.content} 
          # message
          ${message.content}`;
        } else messageContent = message.content;

        const messageLink = {
          string: { data: { value: messageContent } },
          type_id: messageTypeLinkId,
          in: {
            data: [{
              type_id: containTypeLinkId,
              from_id: userLinkId,
            }]
          }
        };

        const { data: [{ id: messageLinkId }] } = await deep.insert(messageLink);

        await deep.insert({
          type_id: await deep.id("@deep-foundation/chatgpt-discord-bot", "MessageId"),
          from_id: messageLinkId,
          to_id: messageLinkId,
          string: {
            data: { value: '' + message.id }
          }
        });
        const { data } = await deep.select({
          type_id: conversationTypeLinkId,
          string: { value: { _eq: channelName } }
        });

        const conversationLinkId = data?.[0]?.id

        if (conversationLinkId > 0) {
          const result = await deep.select({
            tree_id: { _eq: messagingTreeId },
            link: { type_id: { _eq: messageTypeLinkId } },
            root_id: { _eq: conversationLinkId },
            self: { _eq: true }
          }, {
            table: 'tree',
            variables: { order_by: { depth: "desc" } },
            returning: `
                id
                depth
                root_id
                parent_id
                link_id
                link {
                  id
                  from_id
                  type_id
                  to_id
                  value
                  author: out (where: { type_id: { _eq: ${authorTypeLinkId}} }) { 
                    id
                    from_id
                    type_id
                    to_id
                  }
                }`
          })

          const lastMessageId = result?.data?.[0]?.link?.id || conversationLinkId;

          await deep.insert({
            type_id: replyTypeLinkId,
            from_id: messageLinkId,
            to_id: lastMessageId,
            in: {
              data: [{
                type_id: containTypeLinkId,
                from_id: userLinkId,
              }]
            }
          });
        } else {
          await deep.insert({
            string: { data: { value: channelName } },
            type_id: conversationTypeLinkId,
            in: {
              data: [{
                type_id: containTypeLinkId,
                from_id: userLinkId,
              },
              {
                type_id: replyTypeLinkId,
                from_id: messageLinkId,
                in: {
                  data: [{
                    type_id: containTypeLinkId,
                    from_id: userLinkId,
                  }]
                }
              }]
            }
          });
        }
      }
    });
    discordClient.login(BOT_TOKEN);
  });
  return await botListenPromise;
}

startBot();


http.createServer({ maxHeaderSize: 10*1024*1024*1024 }, app).listen(process.env.PORT);
console.log(`Listening ${process.env.PORT} port`);