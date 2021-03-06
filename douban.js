const puppeteer = require('puppeteer')
const Redis = require('ioredis')
const fs = require('fs')
const log = console.log
const redis = new Redis()
redis.on('error', function(err) {
  console.log('Error ' + err)
})

let browser, page
async function start() {
  await init()
  //监听事件------------------
  await addListener()
  //初始页面----------
  await page.goto('https://movie.douban.com/')
  //获取数据，存到redis
  await getData(2000)
  //写到文件
  await writeToFile()
  //结束
  defer()
 
}

function defer(){
    await page.close()
    await browser.close()
    redis.quit()
}
async function init() {
  browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ignoreDefaultArgs: ['--enable-automation'] //设置隐藏navigator.webDriver
    // headless: false
  })
  page = await browser.newPage()
}

async function addListener() {
  await page.setRequestInterception(true)
  //取消下载图片
  page.on('request', interceptedRequest => {
    let url = interceptedRequest.url()
    if (url.indexOf('.png') > -1 || url.indexOf('.jpg') > -1) {
      interceptedRequest.abort()
    } else {
      interceptedRequest.continue()
    }
  })
  //将所有未操作过的a链接存到redis中
  page.on('domcontentloaded', async () => {
    let urls = await page.$$eval('a', a =>
      a
        .map(i => i.getAttribute('href'))
        .filter(i => i && i.match(/https:\/\/movie\.douban\.com\/subject\/\d+/))
        .map(i => i.match(/https:\/\/movie\.douban\.com\/subject\/\d+/)[0])
        .filter(async i => !(await redis.sismember('doneUrl', i)))
    )
    if (urls.length > 0) await redis.sadd('urls', urls)
  })
}

async function writeToFile() {
  return new Promise((resolve, reject) => {
    let res = []
    redis
      .sscanStream('res')
      .on('data', data => {
        log('data :---------- ', data)
        res.push(...data.map(i => JSON.parse(i)))
      })
      .on('end', async () => {
        fs.writeFileSync('./douban.json', JSON.stringify(res))
        redis.del('res')
        redis.del('doneUrl')
        resolve()
      })
  })
}

async function getData(count) {
  let n = 0
  while (n < count) {
    log('current: ', n)
    try {
      let url = await redis.spop('urls')
      await redis.sadd('doneUrl', url)
      log('url: ', url)
      if (url) {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        let info = await page.$$eval('#info ', a => a.map(i => i.innerText))
        info = info[0] && info[0].split('\n').filter(i => i)
        let name = await page.$eval('#content>h1 ', i => i.innerText)
        let pic = await page.$eval('#mainpic img ', img =>
          img.getAttribute('src')
        )
        info.unshift('片名:' + name, '图片:' + pic)
        let tmp = {}
        info.forEach(i => {
          let data = i.split(':')
          tmp[data.shift()] = data.join('').trim()
        })
        if (Object.keys(tmp).length > 0)
          await redis.sadd('res', JSON.stringify(tmp))
          n++
      }
    } catch (e) {
      console.log(e)
    }
  }
}

start()
