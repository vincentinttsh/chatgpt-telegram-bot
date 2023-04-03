import { init, Tiktoken } from "@dqbd/tiktoken/lite/init";
import wasm from "../node_modules/@dqbd/tiktoken/lite/tiktoken_bg.wasm";
import token_params from "@dqbd/tiktoken/encoders/cl100k_base.json";

export default {
	async fetch(request, env, ctx) {
		if (request.method !== "POST") {
			return new Response('Method Not Allowed', { status: 405 })
		}

		const secret_header = "X-Telegram-Bot-Api-Secret-Token";
		const tg_api_key = env.TG_API_KEY;
		const secret = env.TG_WEBHOOK_SECRET;
		const allowed_users = env.ALLOWED_USERS.split(",");

		if (request.headers.get(secret_header) !== secret) {
			return new Response('Unauthorized', { status: 403 })
		}

		const update = await request.json()
		if (!update.message) {
			return new Response('BadRequest', { status: 400 })
		}

		const message = update.message;
		const chat_id = message.chat.id;
		let msg = "";

		console.log(`Recv msg from chat_id: ${chat_id}, username: ${message.chat.username}`)
		if (!allowed_users.includes(chat_id.toString())) {
			msg = "You are not allowed to use this bot";
			ctx.waitUntil(this.sendMsg(chat_id, tg_api_key, msg));
		} else if (!message.text) {
			msg = "Please send me a text message";
			ctx.waitUntil(this.sendMsg(chat_id, tg_api_key, msg));
		} else {
			ctx.waitUntil(this.chatgpt(env, chat_id, message.text));
		}
		return new Response('Ok');
	},
	apiUrl (methodName, token, params = null) {
		let query = '';
		if (params) {
		  query = '?' + new URLSearchParams(params).toString();
		}
		return `https://api.telegram.org/bot${token}/${methodName}${query}`
	},
	sendMsg(chat_id, token, text) {
		return fetch(this.apiUrl('sendMessage', token, {chat_id, text}));
	},
	async message_tokens(model, message) {
		let tokens_per_message = model === "gpt-4" ? 3 : 4;
		let num_tokens = tokens_per_message * 2;
		await init((imports) => WebAssembly.instantiate(wasm, imports));
		const encoder = new Tiktoken(
			token_params.bpe_ranks,
			token_params.special_tokens,
			token_params.pat_str
		);
		const tokens = encoder.encode(message);
		encoder.free();

		return num_tokens + tokens.length;
	},
	async chatgpt(env, chat_id, msg) {
		const url = "https://api.openai.com/v1/chat/completions";
		const model = env["OPENAI_MODEL"];
		const openai_api_key = env["OPENAI_API_KEY"];
		const tg_api_key = env["TG_API_KEY"];
		let max_tokens = env["OPENAI_MAX_TOKENS"];
		let message_tokens = await this.message_tokens(model, msg);
		max_tokens -= message_tokens;

		const ret = await fetch(url, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${openai_api_key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model,
				max_tokens,
				messages: [
					{"role": "user", "content": msg}
				]
			})
		})
		const completion = await ret.json();
		if (completion.error) {
			console.log("Error: ", completion.error.message);
			return this.sendMsg(chat_id, tg_api_key, "The robot no longer listens to you, run!");
		}

		const reply = completion.choices[0].message.content;
		const cost = completion.usage.total_tokens / 1000 * 0.002;
		let help_text = "";
		let wait_list = [
			this.sendMsg(chat_id, tg_api_key, reply),
		];
		if (env.SHOW_DEBUG_INFO === "true") {
			help_text += `Expect prompt token is ${message_tokens}\n
Actual prompt token is ${completion.usage.prompt_tokens}\n`;
		}
		if (env.SHOW_COST === "true") {
			help_text += `Cost is ${cost} USD`;
		}
		if (help_text) {
			wait_list.push(this.sendMsg(chat_id, tg_api_key, help_text));
		}
		return Promise.all(wait_list);
	},
};
