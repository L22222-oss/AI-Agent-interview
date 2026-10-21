const llm = require('../lib/llm');
const judge = require('../lib/judge');

(async () => {
  llm.configure({ provider: 'custom', baseUrl: 'http://127.0.0.1:8899/v1', model: 'mock-model', apiKey: 'sk-mock-x' });
  console.log('enabled=' + llm.enabled());
  try {
    const r = await judge.judge({
      question: '讲讲订单模块',
      answer: '我负责订单模块，加乐观锁解决超卖，失败率从3%降到0.2%。',
      dim: 'execution',
    });
    console.log('source=' + r.source + ' score=' + r.score);
    console.log('comment=' + r.comment);
    console.log('evidence=' + JSON.stringify(r.evidence));
  } catch (e) {
    console.log('THROW ' + e.message);
  }
  llm.configure({ provider: 'custom', baseUrl: '', model: '', apiKey: '' });
})();
