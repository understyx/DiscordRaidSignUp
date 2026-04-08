import discord
from discord.ext import commands
from Warmane import QueryWarmaneArmory
import mariadb
from enum import IntEnum


intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix='.bot ', intents=intents)

try:
    conn = mariadb.connect(
        user="<DB_USER>",
        password="<DB_PASSWORD>",
        host="<DB_HOST>",
        port=3306,
        database="<DB_NAME>"

    )
except mariadb.Error as e:
    print(f"Error connecting to MariaDB Platform: {e}")
    sys.exit(1)


@bot.command(aliases=['summary', 'query'])
async def stalk(ctx, arg1, arg2="Icecrown"):
    if arg2.capitalize() == "Onyxia":
        await ctx.send(embed=QueryWarmaneArmory.create_onyxia_stalk_response(arg1, arg2, conn))
    else:
        await ctx.send(embed=QueryWarmaneArmory.create_stalk_response(arg1, arg2, conn))

@bot.command()
async def checkTalents(ctx, arg1, arg2="Icecrown"):
    QueryWarmaneArmory.test_talents(arg1, arg2)
    await ctx.send("Test!")

@bot.command(aliases=['stalkmulti', 'querymulti'])
async def querymultiple(ctx, *args):
    lines = QueryWarmaneArmory.create_multi_response(*args, conn=conn)
    split_lines = lines.splitlines()
    
    split_lines[0] = split_lines[0][3:]
    split_lines[-1] = split_lines[-1][:-3]

    batch_size = 6
    for i in range(0, len(split_lines), batch_size):
        batch = split_lines[i:i + batch_size]
        response = "\n".join(batch)
        await ctx.send("```" + response + "```")

@bot.command()
async def serverinfo(ctx):
    respnse = list()
    for guild in client.guilds:
        respnse.append(guild.name)

    await ctx.send("\n".join(respnse))

bot.run('<BOT TOKEN>')