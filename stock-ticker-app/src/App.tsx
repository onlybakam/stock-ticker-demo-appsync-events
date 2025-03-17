import { useEffect, useState } from 'react'

import Chart from 'react-apexcharts'
import { AppSyncEventsClient } from './events'
import config from './output.json'

const chart: { options: ApexCharts.ApexOptions } = {
  options: {
    chart: {
      type: 'candlestick',
      animations: { enabled: false },
      toolbar: { show: false },
    },
    title: { text: 'CandleStick Chart', align: 'left' },
    xaxis: { type: 'datetime' },
    yaxis: { tooltip: { enabled: true } },
  },
}

const client = new AppSyncEventsClient(
  `https://${config.StockTickerBackendStack.httpDomain}/event`,
  {
    auth: { mode: 'apiKey', apiKey: config.StockTickerBackendStack.apiKey },
  },
)

type StockPrice = {
  x: number
  y: number[]
}

type DataSeries = { data: StockPrice[] }[]

function App() {
  const [series, setSeries] = useState<DataSeries>([
    {
      data: [],
    },
  ])

  useEffect(() => {
    let unsub: { unsubscribe: () => void }
    async function doSubscribe() {
      unsub = await client.subscribe('/stocks/TICKER', (data) => {
        const price = data as StockPrice
        // console.log(price)
        setSeries((value) => {
          let data = [...value[0].data, price]
          data = data.reverse().slice(0, 50).reverse()
          const updated: DataSeries = [{ data }]
          return updated
        })
      })
    }
    doSubscribe()
    return () => unsub?.unsubscribe()
  }, [])

  return (
    <>
      <div className="p-8 max-w-7xl mx-auto">
        <div className="mx-auto divide-y divide-gray-200 overflow-hidden rounded-lg  shadow bg-white">
          <div className="px-4 py-5 sm:px-6 text-center">
            <h1 className="text-lg font-bold uppercase mb-4">Ticker Demo with AppSync Events</h1>
          </div>
          <div className="px-4 py-5 sm:p-6">
            <div className="aspect-video mx-auto  px-4 sm:px-6 lg:px-8">
              <Chart
                options={chart.options}
                series={series}
                type="candlestick"
                width="100%"
                height="100%"
              />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

export default App
